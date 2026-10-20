const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("cleanup toast localizes its cause and keeps fallback status quieter", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__cleanupFailureToasts;
  });
  globalThis.__cleanupFailureToasts = [];
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-failure-toast-",
    mockModules: {
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__cleanupFailureToasts.push(props)
        });
      `,
      "/utils/windowContext": `
        export const isDictationPanelWindow = () => false;
      `,
    },
  });
  const { default: CleanupFailureToastListener } = await vite.ssrLoadModule(
    "/components/CleanupFailureToastListener.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("es");
  const { recordCleanupFailure, useCleanupFailureStore } = await vite.ssrLoadModule(
    "/stores/cleanupFailureStore.ts"
  );
  useCleanupFailureStore.setState({ pending: 0, lastMessage: "", lastFailure: null });

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(CleanupFailureToastListener)));

  const messageKey = "hooks.audioRecording.errorDescriptions.cleanupTruncated";
  await React.act(async () =>
    recordCleanupFailure({ message: "Model output was truncated", messageKey })
  );

  assert.equal(globalThis.__cleanupFailureToasts.length, 1);
  assert.deepEqual(globalThis.__cleanupFailureToasts[0], {
    title: i18n.t(messageKey),
    secondaryDescription: "Tu dictado se pegó sin limpieza con IA.",
    variant: "destructive",
    duration: 10_000,
  });
  assert.notEqual(i18n.t(messageKey), messageKey, "the cause is translated");
});

const CLASSIFIED_FAILURE = {
  message: "OpenAI rejected your API key.",
  surface: "llm",
  messageKey: "providerErrors.authFailed",
  messageParams: { provider: "OpenAI" },
  settingsTarget: "llms",
  technicalDetails: { provider: "OpenAI", status: 401 },
};

async function recordCleanupFailureToast(t, { dictationWindow, failure = CLASSIFIED_FAILURE }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__cleanupFailureToasts;
  });
  globalThis.__cleanupFailureToasts = [];
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-failure-toast-llm-",
    mockModules: {
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__cleanupFailureToasts.push(props)
        });
      `,
      "/utils/windowContext": `
        export const isDictationPanelWindow = () => ${dictationWindow};
      `,
    },
  });
  const { default: CleanupFailureToastListener } = await vite.ssrLoadModule(
    "/components/CleanupFailureToastListener.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  const { recordCleanupFailure, useCleanupFailureStore } = await vite.ssrLoadModule(
    "/stores/cleanupFailureStore.ts"
  );
  useCleanupFailureStore.setState({ pending: 0, lastMessage: "", lastFailure: null });

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(CleanupFailureToastListener)));

  await React.act(async () => recordCleanupFailure(failure));
  return globalThis.__cleanupFailureToasts.at(-1);
}

test("a classified cleanup failure says why, then that the dictation went in raw, with Open Settings and Copy details", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, { dictationWindow: false });
  assert.equal(toastProps.title, "Cleanup failed");
  assert.equal(
    toastProps.description,
    "OpenAI rejected your API key.\nOriginal dictation pasted without AI cleanup."
  );
  assert.deepEqual(
    toastProps.actions.map(({ label, iconOnly }) => ({ label, iconOnly })),
    [
      { label: "Open Settings", iconOnly: undefined },
      { label: "Copy details", iconOnly: true },
    ]
  );
  assert.equal(toastProps.technicalDetails, undefined, "details are behind Copy details");
  assert.equal(toastProps.secondaryDescription, undefined);
  assert.equal(toastProps.presentation, undefined);
});

test("in the dictation window a classified cleanup failure uses the pill's error card", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, { dictationWindow: true });
  assert.equal(toastProps.presentation, "dictation-error");
  assert.equal(toastProps.duration, 10_000);
  assert.equal(toastProps.actions.length, 2);
});

test("a classified failure whose paste was held back leaves the pill alone and claims no paste", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, {
    dictationWindow: true,
    failure: { ...CLASSIFIED_FAILURE, pasted: false },
  });
  assert.equal(toastProps.title, "Cleanup failed");
  assert.equal(toastProps.description, "OpenAI rejected your API key.");
  assert.equal(toastProps.presentation, undefined, "the held-back paste keeps its pill");
});

// The shape cleanupUnconfiguredNotice returns (pinned in dictationRouting.test.js).
const UNCONFIGURED_NOTICE = {
  message: "AI cleanup is on, but no cleanup model is set up.",
  messageKey: "hooks.audioRecording.cleanupUnconfigured",
  surface: "llm",
  settingsTarget: "llms",
  setupKey: "unconfigured\0providers\0",
};

test("an unconfigured-cleanup notice takes the pill's error card with Open Settings", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, {
    dictationWindow: true,
    failure: { ...UNCONFIGURED_NOTICE, pasted: true },
  });
  assert.equal(toastProps.title, "Cleanup failed");
  assert.equal(
    toastProps.description,
    "AI cleanup is on, but no cleanup model is set up.\nOriginal dictation pasted without AI cleanup."
  );
  assert.deepEqual(
    toastProps.actions.map(({ label }) => label),
    ["Open Settings"]
  );
  assert.equal(toastProps.presentation, "dictation-error");
});

test("an unconfigured-cleanup notice for a dictation that was not pasted claims no paste", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, {
    dictationWindow: true,
    failure: { ...UNCONFIGURED_NOTICE, pasted: false },
  });
  assert.equal(toastProps.description, "AI cleanup is on, but no cleanup model is set up.");
  assert.deepEqual(
    toastProps.actions.map(({ label }) => label),
    ["Open Settings"]
  );
  assert.equal(toastProps.presentation, undefined, "the held-back paste keeps its pill");
});
