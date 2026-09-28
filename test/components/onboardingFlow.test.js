const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/flow.ts");

test("onboarding keeps permissions and the hotkey before setup choice", async () => {
  const { getOnboardingRoute } = await load();
  // finalizeOnboarding registers the dictation hotkey on every path, so the user
  // must still grant the mic and see the key they are getting.
  assert.deepEqual(getOnboardingRoute({ setupMode: null }), [
    "permissions",
    "languages",
    "use-cases",
    "dictation-hotkey",
    "setup-choice",
  ]);
});

test("setup choice appends its two setup steps, then the practice steps", async () => {
  const { getOnboardingRoute } = await load();
  // The demos run on the models the setup steps configured, so they follow them.
  assert.deepEqual(getOnboardingRoute({ setupMode: "self-hosted" }).slice(4), [
    "setup-choice",
    "self-hosted-dictation",
    "self-hosted-assistant",
    "dictation-demo",
    "notes",
    "assistant-hotkey",
    "assistant-demo",
  ]);
  assert.deepEqual(getOnboardingRoute({ setupMode: "local" }).slice(5, 7), [
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
  // A session saved by the route with provider setup restarts from the top.
  assert.equal(
    parseOnboardingSession(
      JSON.stringify({ ...createOnboardingSession(), version: 2, setupMode: "byok" })
    ),
    null
  );
  // Steps this build no longer has restart too.
  for (const currentStepId of ["auth", "byok-dictation"]) {
    assert.equal(
      parseOnboardingSession(JSON.stringify({ ...createOnboardingSession(), currentStepId })),
      null
    );
  }
  // A setup mode this build no longer has is picked again.
  assert.equal(
    parseOnboardingSession(JSON.stringify({ ...createOnboardingSession(), setupMode: "byok" }))
      .setupMode,
    null
  );

  const session = createOnboardingSession();
  assert.deepEqual(parseOnboardingSession(JSON.stringify(session)), session);

  const withoutOptionalFields = { ...session };
  delete withoutOptionalFields.screenContextRequested;
  delete withoutOptionalFields.resume;
  assert.equal(
    parseOnboardingSession(JSON.stringify(withoutOptionalFields)).screenContextRequested,
    false
  );
  assert.deepEqual(
    parseOnboardingSession(JSON.stringify(withoutOptionalFields)).resume,
    createOnboardingSession().resume
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

test("sessions retain safe within-step state without accepting secrets", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const session = createOnboardingSession();
  session.currentStepId = "self-hosted-dictation";
  session.resume.dictationHotkeyConfirmed = true;
  session.resume.dictationDemoCompleted = true;
  session.resume.selfHosted["self-hosted-dictation"] = {
    baseUrl: "https://self-hosted.example.com",
    model: "whisper-local",
  };
  session.resume.localModels["local-assistant"] = {
    provider: "qwen",
    modelId: "qwen-9b",
  };

  const serialized = JSON.stringify(session);
  assert.doesNotMatch(serialized, /password|apiKey|clientSecret/);
  assert.deepEqual(parseOnboardingSession(serialized), session);

  // A key an older build wrote into a draft is dropped rather than read back.
  const keyedDraft = JSON.parse(serialized);
  keyedDraft.resume.selfHosted["self-hosted-dictation"].apiKey = "secret";
  assert.deepEqual(parseOnboardingSession(JSON.stringify(keyedDraft)), session);

  const malformedDraft = JSON.parse(serialized);
  malformedDraft.resume.selfHosted["self-hosted-dictation"].baseUrl = 42;
  malformedDraft.resume.localModels["local-assistant"].modelId = false;
  const parsed = parseOnboardingSession(JSON.stringify(malformedDraft));
  assert.equal(parsed.resume.selfHosted["self-hosted-dictation"].baseUrl, "");
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
  // Later legacy steps preceded the setup choice the route now makes first.
  assert.equal(migrateLegacyOnboardingStep("5"), "setup-choice");
  assert.equal(migrateLegacyOnboardingStep("999"), "setup-choice");
});

test("route helpers recover from ineligible steps", async () => {
  const { getNextOnboardingStep, getOnboardingRoute, reconcileStepWithRoute } = await load();
  const route = getOnboardingRoute({ setupMode: null });
  assert.equal(reconcileStepWithRoute("assistant-demo", route), "setup-choice");
  assert.equal(getNextOnboardingStep("permissions", route), "languages");
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
  assert.deepEqual(getOnboardingProgress("languages", route), { index: 0, total: 10 });
  assert.deepEqual(getOnboardingProgress("local-assistant", route), { index: 5, total: 10 });
  assert.deepEqual(getOnboardingProgress("assistant-demo", route), { index: 9, total: 10 });
});

test("progress total tracks the conditional parts of the route", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  // Before a setup is picked the route counts the four steps up to setup-choice.
  const unplanned = getOnboardingRoute({ setupMode: null });
  assert.deepEqual(getOnboardingProgress("setup-choice", unplanned), { index: 3, total: 4 });

  // Picking a setup appends its pair and the practice steps, so the row grows
  // at that moment.
  const selfHosted = getOnboardingRoute({ setupMode: "self-hosted" });
  assert.deepEqual(getOnboardingProgress("setup-choice", selfHosted), { index: 3, total: 10 });
  assert.deepEqual(getOnboardingProgress("self-hosted-assistant", selfHosted), {
    index: 5,
    total: 10,
  });

  // An off-route step has no position to report.
  assert.equal(getOnboardingProgress("local-dictation", selfHosted), null);
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
  const past = parseOnboardingSession(preResumeSession("assistant-demo"));
  assert.equal(past.resume.dictationHotkeyConfirmed, true);
  assert.equal(past.resume.assistantHotkeyConfirmed, true);

  // Notes precedes the assistant steps, so a session standing there is still
  // ahead of the assistant hotkey and gets shown that step.
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
