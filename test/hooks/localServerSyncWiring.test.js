const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The main process decides the shared llama-server from what each window
// syncs, so this pins the renderer half: every scope's resolved local model
// rides on the sync, and a change to one resyncs. SSR cannot run useEffect, so
// the settings provider is mounted for real.
async function mountSettings(t) {
  // Registered before the browser globals so it runs before their teardown.
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });

  const syncs = [];
  const known = {
    syncStartupPreferences: async (prefs) => {
      syncs.push(prefs);
    },
    // Startup seeds the agent name into the dictionary. Left pending, the write
    // never reaches its cloud push, which imports a module after teardown.
    applyDictionaryChanges: () => new Promise(() => {}),
  };
  // Every other bridge call the provider makes is irrelevant here.
  const electronAPI = new Proxy(known, {
    get: (target, name) =>
      name in target
        ? target[name]
        : String(name).startsWith("on")
          ? () => () => {}
          : async () => undefined,
  });

  installBrowserGlobals(t, { window: { electronAPI } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-server-sync-wiring-test-",
  });
  const [{ SettingsProvider }, { useSettingsStore }] = await Promise.all([
    vite.ssrLoadModule("/hooks/useSettings.ts"),
    vite.ssrLoadModule("/stores/settingsStore.ts"),
  ]);

  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(SettingsProvider, null, null)));
  rootRef.current = root;

  return { syncs, useSettingsStore };
}

test("a window syncs its scopes' local models and resyncs when one changes", async (t) => {
  const { syncs, useSettingsStore } = await mountSettings(t);

  assert.ok(syncs.length > 0, "the window syncs on mount");
  assert.equal("policySettled" in syncs.at(-1), false);

  await React.act(async () =>
    useSettingsStore.setState({ chatAgentMode: "local", chatAgentModel: "qwen3.5-9b-q4_k_m" })
  );
  assert.equal(syncs.at(-1).chatAgentMode, "local");
  assert.equal(syncs.at(-1).chatAgentModel, "qwen3.5-9b-q4_k_m");
});
