const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
async function setup(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const listeners = {};
  Object.assign(globalThis.window.electronAPI, {
    onMeetingNotificationFolderCreated: (cb) => (
      (listeners.folder = cb),
      () => delete listeners.folder
    ),
    getFolders: async () => [{ id: 4, space_id: 1, name: "Test" }],
    getFolderNoteCounts: async () => [],
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-folder-refresh-",
  });
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  function Mounted() {
    React.useEffect(store.subscribeMeetingNotificationFolders, []);
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Mounted)));

  return { store, listeners };
}
test("a mounted panel reloads folders when the notification creates one", async (t) => {
  const { store, listeners } = await setup(t);
  await listeners.folder({ folderId: 4 });
  assert.equal(store.getFoldersValue()[0].id, 4);
});
