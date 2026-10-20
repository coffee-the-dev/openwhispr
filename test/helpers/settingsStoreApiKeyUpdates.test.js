const test = require("node:test");
const assert = require("node:assert/strict");
const { SCOPE_API_KEYS } = require("../../src/config/secretKeys");
const { deferred } = require("./harness/deferred");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const bindings = [
  ...SCOPE_API_KEYS,
  ...[
    ["customTranscriptionApiKey", "getCustomTranscriptionKey"],
    ["cleanupCustomApiKey", "getCleanupCustomKey"],
  ].map(([storeKey, get]) => ({ storeKey, get })),
];

async function loadSettings(t, overrides = {}) {
  const keys = new Map(bindings.map(({ storeKey }) => [storeKey, `old-${storeKey}`]));
  const events = new EventTarget();
  let update;
  const api = Object.fromEntries(
    bindings.map(({ storeKey, get }) => [get, async () => keys.get(storeKey)])
  );
  const { window, storage } = installBrowserGlobals(t, {
    initialStorage: { _dictationAgentSeeded: "1", customDictionary: '["OpenWhispr"]' },
    window: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      warnings: [],
      electronAPI: {
        ...api,
        setDictionary: async () => {},
        onApiKeyUpdated: (callback) => {
          update = callback;
        },
        ...overrides,
      },
    },
  });
  const vite = await createRendererServer(t, {
    mockModules: {
      "/utils/logger": `export default {
        debug() {}, info() {}, error() {}, logReasoning() {},
        warn: (...args) => window.warnings.push(args)
      };`,
    },
  });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  return { ...settings, keys, storage, window, vite, update: (key) => update(key) };
}

test("all registered secrets refresh in memory without persistence or save loops", async (t) => {
  const context = await loadSettings(t);
  await context.initializeSettings();
  const changes = [];
  let saves = 0;
  let persists = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  context.window.addEventListener("api-key-changed", () => changes.push(true));
  context.window.electronAPI.saveAllKeysToEnv = async () => {
    persists += 1;
  };
  for (const { storeKey, get } of bindings) {
    context.window.electronAPI[get.replace(/^get/, "save")] = async () => {
      saves += 1;
    };
    for (const value of [`new-${storeKey}`, ""]) {
      context.keys.set(storeKey, value);
      await context.update(storeKey);
      assert.equal(context.useSettingsStore.getState()[storeKey], value, storeKey);
      assert.equal(context.storage.getItem(storeKey), null, storeKey);
    }
  }
  t.mock.timers.tick(1000);
  assert.equal(saves, 0);
  assert.equal(persists, 0);
  assert.equal(changes.length, bindings.length * 2);
});

for (const { name, value, failHydration } of [
  { name: "replacement", value: "new-custom" },
  { name: "removal", value: "" },
  { name: "failed hydration", value: "new-custom", failHydration: true },
]) {
  test(`startup ${name} survives hydration`, { timeout: 15_000 }, async (t) => {
    const started = deferred();
    const held = deferred();
    let reads = 0;
    const context = await loadSettings(t, {
      getCustomTranscriptionKey: async () => {
        if (++reads > 1) return value;
        started.resolve();
        await held.promise;
        if (failHydration) throw new Error("hydration failed");
        return "old-custom";
      },
    });
    const initialization = context.initializeSettings();
    await started.promise;
    await context.update("customTranscriptionApiKey");
    held.resolve();
    await initialization;
    assert.equal(context.useSettingsStore.getState().customTranscriptionApiKey, value);
    assert.equal(reads, 2);
    assert.equal(context.storage.getItem("customTranscriptionApiKey"), null);
  });
}

test("unknown settings cannot invoke getters, and refresh errors cannot log secrets", async (t) => {
  const context = await loadSettings(t);
  await context.initializeSettings();
  let forbiddenReads = 0;
  context.window.electronAPI.getDictationKey = async () => {
    forbiddenReads += 1;
    return "not-a-secret";
  };
  await context.update("dictationKey");
  assert.equal(forbiddenReads, 0);
  context.window.electronAPI.getCustomTranscriptionKey = async () => {
    throw new Error("secret-leak-marker");
  };
  await context.update("customTranscriptionApiKey");
  assert.ok(context.window.warnings.length > 0);
  assert.ok(!JSON.stringify(context.window.warnings).includes("secret-leak-marker"));
  assert.equal(
    context.useSettingsStore.getState().customTranscriptionApiKey,
    "old-customTranscriptionApiKey"
  );
});
