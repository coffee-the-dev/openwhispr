const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/flow.ts");

test("onboarding keeps permissions and the hotkey before setup choice", async () => {
  const { getOnboardingRoute } = await load();
  // finalizeOnboarding registers the dictation hotkey on every path, so the user
  // must still grant the mic and see the key they are getting.
  assert.deepEqual(getOnboardingRoute({ setupMode: null }), [
    "permissions",
    "dictation-hotkey",
    "setup-choice",
  ]);
});

test("setup choice appends the selected two-stage route", async () => {
  const { getOnboardingRoute } = await load();
  assert.deepEqual(getOnboardingRoute({ setupMode: "byok" }), [
    "permissions",
    "dictation-hotkey",
    "setup-choice",
    "byok-dictation",
    "byok-assistant",
  ]);
  assert.deepEqual(getOnboardingRoute({ setupMode: "local" }).slice(-2), [
    "local-dictation",
    "local-assistant",
  ]);
});

test("notes starts with Skip and switches to Continue after a calendar connects", async () => {
  const { getNotesFooterAction } = await load();

  assert.equal(getNotesFooterAction({ hasConnectedCalendar: false }), "skip");
  assert.equal(getNotesFooterAction({ hasConnectedCalendar: true }), "continue");
});

test("versioned sessions reject malformed or old data", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  assert.equal(parseOnboardingSession(null), null);
  assert.equal(parseOnboardingSession("not json"), null);
  assert.equal(parseOnboardingSession('{"version":1,"currentStepId":"permissions"}'), null);
  // The sign-in step no longer exists, so a session saved on it restarts.
  assert.equal(
    parseOnboardingSession(JSON.stringify({ ...createOnboardingSession(), currentStepId: "auth" })),
    null
  );

  const session = createOnboardingSession();
  assert.deepEqual(parseOnboardingSession(JSON.stringify(session)), session);

  const legacyV2 = { ...session };
  delete legacyV2.selfHostedRequested;
  delete legacyV2.screenContextRequested;
  delete legacyV2.resume;
  assert.equal(parseOnboardingSession(JSON.stringify(legacyV2)).selfHostedRequested, false);
  assert.equal(parseOnboardingSession(JSON.stringify(legacyV2)).screenContextRequested, false);
  assert.deepEqual(
    parseOnboardingSession(JSON.stringify(legacyV2)).resume,
    createOnboardingSession().resume
  );
  assert.equal(
    parseOnboardingSession(JSON.stringify({ ...session, selfHostedRequested: "yes" })),
    null
  );
  assert.equal(
    parseOnboardingSession(JSON.stringify({ ...session, screenContextRequested: "yes" })),
    null
  );
});

// The permissions step's Enable click must survive the quit-and-reopen macOS
// asks for after granting Screen Recording, or the OS permission lands with
// the Voice Assistant setting still off.
test("a session keeps the screen-context request latch across a relaunch", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const session = { ...createOnboardingSession(), screenContextRequested: true };
  assert.equal(parseOnboardingSession(JSON.stringify(session)).screenContextRequested, true);
});

test("v2 sessions retain safe within-step state without accepting secrets", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const session = createOnboardingSession();
  session.currentStepId = "byok-dictation";
  session.resume.dictationHotkeyConfirmed = true;
  session.resume.dictationDemoCompleted = true;
  session.resume.byok["byok-dictation"] = {
    selectedProvider: "openai",
    selectedModel: "gpt-4o-mini-transcribe",
    baseUrl: "https://self-hosted.example.com",
    customModel: "whisper-local",
  };
  session.resume.localModels["local-assistant"] = {
    provider: "qwen",
    modelId: "qwen-9b",
  };

  const serialized = JSON.stringify(session);
  assert.doesNotMatch(serialized, /password|apiKey|cortiClientId|clientSecret/);
  assert.deepEqual(parseOnboardingSession(serialized), session);

  // Corti's client id is one of the safeStorage-encrypted secrets, so a draft
  // written by an older build has to be dropped rather than read back.
  const legacyDraft = JSON.parse(serialized);
  legacyDraft.resume.byok["byok-dictation"].cortiClientId = "client-id";
  assert.deepEqual(parseOnboardingSession(JSON.stringify(legacyDraft)), session);

  const malformedDraft = JSON.parse(serialized);
  malformedDraft.resume.byok["byok-dictation"].selectedProvider = 42;
  malformedDraft.resume.localModels["local-assistant"].modelId = false;
  const parsed = parseOnboardingSession(JSON.stringify(malformedDraft));
  assert.equal(parsed.resume.byok["byok-dictation"].selectedProvider, "");
  assert.equal(parsed.resume.localModels["local-assistant"].modelId, "");
});

test("an explicit restart clears every persisted route choice", async () => {
  const { resetOnboardingProgress } = await load();
  const values = new Map([
    ["onboardingSessionV2", '{"currentStepId":"permissions"}'],
    ["onboardingCurrentStep", "dictation-hotkey"],
    ["onboardingCompleted", "true"],
    ["localSetupPending", "true"],
    ["pendingLocalModelSelectionsV1", '{"assistant":{"provider":"qwen","modelId":"qwen-9b"}}'],
  ]);
  const storage = { removeItem: (key) => values.delete(key) };

  resetOnboardingProgress(storage);

  assert.deepEqual([...values.keys()], []);
});

test("legacy numeric steps migrate conservatively", async () => {
  const { migrateLegacyOnboardingStep } = await load();
  assert.equal(migrateLegacyOnboardingStep(null), "permissions");
  assert.equal(migrateLegacyOnboardingStep("0"), "permissions");
  // Old steps 1-2 predate the old permissions step, so they must resume at
  // the new flow's permissions step rather than past it.
  assert.equal(migrateLegacyOnboardingStep("1"), "permissions");
  assert.equal(migrateLegacyOnboardingStep("2"), "permissions");
  assert.equal(migrateLegacyOnboardingStep("4"), "dictation-hotkey");
  assert.equal(migrateLegacyOnboardingStep("999"), "setup-choice");
});

test("route helpers recover from ineligible steps", async () => {
  const { getNextOnboardingStep, getOnboardingRoute, reconcileStepWithRoute } = await load();
  const route = getOnboardingRoute({ setupMode: null });
  assert.equal(reconcileStepWithRoute("assistant-demo", route), "setup-choice");
  assert.equal(getNextOnboardingStep("permissions", route), "dictation-hotkey");
  assert.equal(getNextOnboardingStep("setup-choice", route), null);
});

test("progress counts every step the user is shown, once each", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ setupMode: "local" });

  // Permissions renders in the compact frame with no footer, so it carries no
  // row and must not inflate the total.
  assert.equal(getOnboardingProgress("permissions", route), null);

  const counted = route.filter((stepId) => getOnboardingProgress(stepId, route) !== null);
  assert.deepEqual(
    counted.map((stepId) => getOnboardingProgress(stepId, route).index),
    counted.map((_, index) => index)
  );
  assert.deepEqual(getOnboardingProgress("dictation-hotkey", route), { index: 0, total: 4 });
  assert.deepEqual(getOnboardingProgress("local-assistant", route), { index: 3, total: 4 });
});

test("progress total tracks the conditional parts of the route", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  // Before a setup is picked the route counts dictation-hotkey and setup-choice:
  // a two-dot row.
  const unplanned = getOnboardingRoute({ setupMode: null });
  assert.deepEqual(getOnboardingProgress("setup-choice", unplanned), { index: 1, total: 2 });

  // Picking a setup appends the provider pair, so the row grows by two at that
  // moment and the last provider step is what fills it.
  const byok = getOnboardingRoute({ setupMode: "byok" });
  assert.deepEqual(getOnboardingProgress("setup-choice", byok), { index: 1, total: 4 });
  assert.deepEqual(getOnboardingProgress("byok-assistant", byok), { index: 3, total: 4 });

  // An off-route step has no position to report.
  assert.equal(getOnboardingProgress("notes", byok), null);
});

test("a session written before the resume flags infers its hotkey confirmations", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const preResumeSession = (currentStepId) => {
    const { resume, ...session } = { ...createOnboardingSession(), currentStepId };
    void resume;
    return JSON.stringify(session);
  };

  // The shipped build persists this shape. Read back as "never confirmed", a
  // macOS session resuming past the hotkey step lets finalizeOnboarding replace
  // the chord the user confirmed on that build, with no screen ever showing it.
  const past = parseOnboardingSession(preResumeSession("setup-choice"));
  assert.equal(past.resume.dictationHotkeyConfirmed, true);
  assert.equal(past.resume.assistantHotkeyConfirmed, true);

  // Notes now precedes the assistant steps, so a session standing there is
  // still ahead of the assistant hotkey and gets shown that step.
  const onNotes = parseOnboardingSession(preResumeSession("notes"));
  assert.equal(onNotes.resume.dictationHotkeyConfirmed, true);
  assert.equal(onNotes.resume.assistantHotkeyConfirmed, false);

  // Not yet reached is genuinely unconfirmed: the step still has to be shown, and
  // onboarding stays free to open it on the platform's onboarding chord.
  const before = parseOnboardingSession(preResumeSession("permissions"));
  assert.equal(before.resume.dictationHotkeyConfirmed, false);
  assert.equal(before.resume.assistantHotkeyConfirmed, false);

  // Standing on the step is not having finished it.
  const on = parseOnboardingSession(preResumeSession("dictation-hotkey"));
  assert.equal(on.resume.dictationHotkeyConfirmed, false);
  assert.equal(on.resume.assistantHotkeyConfirmed, false);

  // Nothing else is inferred — a demo the user never ran must still gate Continue.
  assert.equal(past.resume.dictationDemoCompleted, false);
  assert.equal(past.resume.assistantDemoCompleted, false);
});
