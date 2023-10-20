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
  node: ComponentNode | ComponentSetNode;
  count: number;
  dependsOn: (ComponentNode | ComponentSetNode)[];
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
  node: ComponentNode | ComponentSetNode
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
      count: node.type === 'COMPONENT_SET' ? 0 : 1, // don't count the initial wrapper
    },
  ];
};

/** Resolves to the `ComponentNode` or `ComponentSetNode` for Components with Variants */
const getMainComponent = ({ mainComponent }: InstanceNode) => {
  if (mainComponent?.parent?.type === 'COMPONENT_SET') {
    return mainComponent.parent;
  }
  return mainComponent;
};

const findComponentsRecursive = (
  node: BaseNode,
  parentComponentIds: string[],
  finds: ComponentCount[],
  ignoredSectionsOrFrames: string[]
): ComponentCount[] => {
  if (!node || isContainedInSectionOrFrame(node, ignoredSectionsOrFrames)) {
    return finds;
  }
  if (isInstanceNode(node)) {
    const mainComponent = getMainComponent(node);
    if (
      mainComponent === null ||
      isContainedInSectionOrFrame(mainComponent, ignoredSectionsOrFrames)
    ) {
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
          updatedFinds,
          ignoredSectionsOrFrames
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
      updatedFinds,
      ignoredSectionsOrFrames
    );
  });
  return updatedFinds;
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
    [],
    ignoredSectionsOrFrames
  ).map((r) => {
    return {
      ...r,
      node: {
        id: r.node.id,
        name: r.node.name,
        pageId: getPage(r.node)?.id,
      },
      dependsOn: r.dependsOn
        // .filter((d) => !isContainedInSectionOrFrame(d, ignoredSectionsOrFrames))
        .map((d) => ({
          id: d.id,
          name: d.name,
          pageId: getPage(d)?.id,
        })),
    };
  });

  figma.ui.postMessage({
    type: 'result',
    componentsWithDependencies: componentsWithDependencies.sort((a, b) => {
      const aIsStandalone = a.dependsOn.length === 0;
      const bIsStandalone = b.dependsOn.length === 0;
      if (aIsStandalone && !bIsStandalone) {
        return -1;
      }
      if (bIsStandalone && !aIsStandalone) {
        return 1;
      }
      return 0;
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

figma.ui.onmessage = async (msg, props) => {
  switch (msg.type) {
    case 'focus-instance': {
      handleFocusInstance(msg.pageId, msg.instanceId);
      return;
    }
    case 'scan': {
      ignoredSectionsOrFrames = msg.ignoredSectionsOrFrames;
      await figma.clientStorage.setAsync(
        'ignored-sections-or-frames',
        ignoredSectionsOrFrames
      );
      scanSelection(ignoredSectionsOrFrames);
      return;
    }
    case 'init': {
      ignoredSectionsOrFrames = await figma.clientStorage.getAsync(
        'ignored-sections-or-frames'
      );
      figma.ui.postMessage({
        type: 'settings-retrieved',
        ignoredSectionsOrFrames: ignoredSectionsOrFrames,
      });
      scanSelection(ignoredSectionsOrFrames);
      return;
    }
    default:
      console.error('unsupported message', msg);
  }
};
