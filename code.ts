// This plugin will open a tab that indicates that it will monitor the current
// selection on the page. It cannot change the document itself.

// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).

// This shows the HTML page in "ui.html".
figma.showUI(__html__, { themeColors: true });

type CoreNodeInfo = { id: string; pageId: string; name: string };
type ComponentCount = {
  node: ComponentNode;
  count: number;
  dependsOn: ComponentNode[];
};

const isInstanceNode = (node: BaseNode): node is InstanceNode =>
  node.type === 'INSTANCE';

/** Helper to get the Page a node is contained in */
const getPage = (node: BaseNode): PageNode | undefined => {
  if (node.parent?.type === 'PAGE') {
    return node.parent;
  }
  return node.parent ? getPage(node.parent) : undefined;
};

/** global var to hold ignored Sections set in UI */
let ignoredSectionsOrFrames: string[] = [];

/** Helper to recursively check if node is in one of the submitted Sections/Frames */
const isContainedInSectionOrFrame = (
  node: BaseNode,
  sections: string[]
): boolean => {
  if (
    (node.parent?.type === 'SECTION' || node.parent?.type === 'FRAME') &&
    sections.includes(node.parent.name)
  ) {
    return true;
  }
  return node.parent
    ? isContainedInSectionOrFrame(node.parent, sections)
    : false;
};

const updateFinds = (
  finds: ComponentCount[],
  node: ComponentNode
): ComponentCount[] => {
  const index = finds.findIndex((c) => c.node.id === node.id);
  if (index >= 0) {
    finds[index].count++;
    return finds;
  }
  return [
    ...finds,
    {
      node,
      dependsOn: [],
      count: 1,
    },
  ];
};

const findComponentsRecursive = (
  node: BaseNode,
  parentComponentIds: string[],
  finds: ComponentCount[]
): ComponentCount[] => {
  if (!node) {
    return finds;
  }
  if (isInstanceNode(node)) {
    const mainComponent = node.mainComponent;
    if (mainComponent === null) {
      return finds;
    }

    // mark dependencies
    parentComponentIds.forEach((p) => {
      finds.forEach((f) => {
        if (f.node.id === p && !f.dependsOn.includes(mainComponent)) {
          f.dependsOn.push(mainComponent);
        }
      });
    });

    let updatedFinds = [...finds];
    if (node.children) {
      node.children.forEach((childNode) => {
        updatedFinds = findComponentsRecursive(
          childNode,
          parentComponentIds.includes(mainComponent.id)
            ? parentComponentIds
            : [...parentComponentIds, mainComponent.id],
          updatedFinds
        );
      });
    }
    return updateFinds(updatedFinds, mainComponent);
  }

  if (!('children' in node) || !node.children) {
    return finds;
  }
  let updatedFinds = [...finds];
  node.children.forEach((childNode) => {
    updatedFinds = findComponentsRecursive(
      childNode,
      parentComponentIds,
      updatedFinds
    );
  });
  return updatedFinds;
};

const formatName = (node: ComponentNode) => {
  if (node.variantProperties && node.parent?.type === 'COMPONENT_SET') {
    return node.parent.name;
  }
  return node.name;
};

/** Start the scan for Components in the current selection */
const scanSelection = (ignoredSectionsOrFrames: string[]) => {
  const baseNode: BaseNode = figma.currentPage.selection[0]
    ? figma.currentPage.selection[0]
    : figma.currentPage;
  if (!('findAll' in baseNode)) {
    return;
  }

  const componentsWithDependencies = findComponentsRecursive(
    baseNode,
    [],
    []
  ).filter(
    (r) => !isContainedInSectionOrFrame(r.node, ignoredSectionsOrFrames)
  );

  figma.ui.postMessage({
    type: 'result',
    componentsWithDependencies: componentsWithDependencies.map((r) => {
      return {
        ...r,
        node: {
          id: r.node.id,
          name: formatName(r.node),
          pageId: getPage(r.node)?.id,
        },
        dependsOn: r.dependsOn
          .filter(
            (d) => !isContainedInSectionOrFrame(d, ignoredSectionsOrFrames)
          )
          .map((d) => ({
            id: d.id,
            name: formatName(d),
            pageId: getPage(d)?.id,
          })),
      };
    }),
  });
};

// This monitors the selection changes and posts the selection to the UI
figma.on('selectionchange', () => scanSelection(ignoredSectionsOrFrames));

/** Main handler for `focus-instance` */
const handleFocusInstance = (pageId: string, instanceId: string) => {
  const page = figma.getNodeById(pageId) as PageNode;
  const node = figma.getNodeById(instanceId) as SceneNode;
  if (!page || !node) {
    const error = `Could not find ${
      !page ? 'Page' : 'Node'
    } with ID: ${instanceId}`;
    console.error(error);
    figma.ui.postMessage({ type: 'error', error });
    return;
  }

  page.selection = [node];
  figma.currentPage = page;
  figma.viewport.scrollAndZoomIntoView([node]);
};

figma.ui.onmessage = (msg, props) => {
  switch (msg.type) {
    case 'focus-instance': {
      handleFocusInstance(msg.pageId, msg.instanceId);
      return;
    }
    case 'scan': {
      ignoredSectionsOrFrames = msg.ignoredSectionsOrFrames;
      figma.clientStorage.setAsync(
        'ignored-sections-or-frames',
        ignoredSectionsOrFrames
      );
      console.log('ignored-sections-or-frames set', ignoredSectionsOrFrames);
      scanSelection(ignoredSectionsOrFrames);
      return;
    }
    case 'init': {
      figma.clientStorage
        .getAsync('ignored-sections-or-frames')
        .then((ignoredSectionsOrFrames: string[] = msg.default || []) => {
          figma.ui.postMessage({
            type: 'settings-retrieved',
            ignoredSectionsOrFrames: ignoredSectionsOrFrames,
          });
          scanSelection(ignoredSectionsOrFrames);
        });
      return;
    }
    default:
      console.error('unsupported message', msg);
  }
};
