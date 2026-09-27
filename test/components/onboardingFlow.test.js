const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/flow.ts");

test("account flow includes the complete guided setup", async () => {
  const { getOnboardingRoute } = await load();
  assert.deepEqual(getOnboardingRoute({ authPath: "account", setupMode: null }), [
    "auth",
    "permissions",
    "languages",
    "use-cases",
    "dictation-hotkey",
    "dictation-demo",
    "notes",
    "assistant-hotkey",
    "assistant-demo",
    "setup-choice",
  ]);
});

// The assistant demo offers to suggest meeting times from a connected calendar,
// so the Notes step that connects one has to come first.
test("notes precedes the assistant steps on the account route", async () => {
  const { getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ authPath: "account", setupMode: null });
  assert.ok(route.indexOf("notes") < route.indexOf("assistant-hotkey"));
  assert.equal(route.indexOf("assistant-demo"), route.indexOf("assistant-hotkey") + 1);
});

test("macOS accessibility features stay deferred until the permissions screen", async () => {
  const { shouldInitializeMacAccessibilityFeatures } = await load();

  assert.equal(shouldInitializeMacAccessibilityFeatures("auth"), false);
  assert.equal(shouldInitializeMacAccessibilityFeatures("permissions"), true);
  assert.equal(shouldInitializeMacAccessibilityFeatures("dictation-hotkey"), true);
  assert.equal(shouldInitializeMacAccessibilityFeatures("notes"), true);
});

test("onboarding permission checks use the resolved macOS feature gate", () => {
  const source = readFileSync("src/components/OnboardingFlow.tsx", "utf8");

  assert.ok(
    source.indexOf("const currentStepId = reconcileStepWithRoute") <
      source.indexOf("const permissions = usePermissions")
  );
  assert.ok(
    source.includes(
      "macAccessibilityChecksEnabled: shouldInitializeMacAccessibilityFeatures(currentStepId)"
    )
  );
});

test("guest flow keeps permissions and the hotkey before setup choice", async () => {
  const { getOnboardingRoute } = await load();
  // finalizeOnboarding registers the dictation hotkey on every path, so guests
  // must still grant the mic and see the key they are getting.
  assert.deepEqual(getOnboardingRoute({ authPath: "guest", setupMode: null }), [
    "auth",
    "permissions",
    "dictation-hotkey",
    "setup-choice",
  ]);
});

test("setup choice appends the selected two-stage route", async () => {
  const { getOnboardingRoute } = await load();
  assert.deepEqual(getOnboardingRoute({ authPath: "guest", setupMode: "byok" }), [
    "auth",
    "permissions",
    "dictation-hotkey",
    "setup-choice",
    "byok-dictation",
    "byok-assistant",
  ]);
  assert.deepEqual(getOnboardingRoute({ authPath: "account", setupMode: "local" }).slice(-2), [
    "local-dictation",
    "local-assistant",
  ]);
});

test("a confirmed enterprise workspace ends the account route at the last guided step", async () => {
  const { getOnboardingRoute } = await load();
  const route = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    skipSetupChoice: true,
  });
  assert.equal(route.at(-1), "assistant-demo");
  assert.equal(route.includes("setup-choice"), false);
});

test("the setup decision step is whichever step precedes setup choice", async () => {
  const { getOnboardingRoute, isSetupDecisionStep } = await load();
  const withChoice = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
  });
  assert.equal(isSetupDecisionStep("assistant-demo", withChoice), true);
  assert.equal(isSetupDecisionStep("notes", withChoice), false);

  const managed = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    skipSetupChoice: true,
  });
  assert.equal(isSetupDecisionStep("assistant-demo", managed), true);
  assert.equal(isSetupDecisionStep("notes", managed), false);

  // Provider steps finish their own setup mode; workspace resolution is moot there.
  const byok = getOnboardingRoute({ authPath: "account", setupMode: "byok" });
  assert.equal(isSetupDecisionStep("byok-assistant", byok), false);
  assert.equal(isSetupDecisionStep("assistant-demo", byok), true);
});

test("notes starts with Skip and switches to Continue after a calendar connects", async () => {
  const { getNotesFooterAction } = await load();

  assert.equal(
    getNotesFooterAction({ setupDecisionPending: false, hasConnectedCalendar: false }),
    "skip"
  );
  assert.equal(
    getNotesFooterAction({ setupDecisionPending: false, hasConnectedCalendar: true }),
    "continue"
  );
  // Naming this state rather than returning null: the footer has to keep showing a
  // Continue while workspaces resolve, disabled and loading. Reading it as "no
  // action" left the step with nothing but Back and no explanation.
  assert.equal(
    getNotesFooterAction({ setupDecisionPending: true, hasConnectedCalendar: true }),
    "loading"
  );
  assert.equal(
    getNotesFooterAction({ setupDecisionPending: true, hasConnectedCalendar: false }),
    "loading"
  );
});

test("enterprise workspace entitlement requires a current paid entitlement", async () => {
  const { isEnterpriseWorkspaceEntitled } = await load();
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "enterprise", status: "active" }), true);
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "enterprise", status: "trialing" }), true);
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "enterprise", status: "past_due" }), false);
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "pro", status: "active" }), false);
  assert.equal(isEnterpriseWorkspaceEntitled(null), false);
});

test("only a signed-in account with an uncommitted choice skips enterprise setup", async () => {
  const { shouldSkipOnboardingSetupChoice } = await load();
  const base = {
    isSignedIn: true,
    authPath: "account",
    setupMode: null,
    activeWorkspace: { plan: "enterprise", status: "active" },
  };

  assert.equal(shouldSkipOnboardingSetupChoice(base), true);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, setupMode: "cloud" }), true);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, setupMode: "local" }), false);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, authPath: "guest" }), false);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, isSignedIn: false }), false);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, activeWorkspace: null }), false);
});

test("a fresh multi-workspace account resolves its enterprise workspace", async () => {
  const { resolveEnterpriseWorkspaceForOnboarding } = await load();
  const personal = { id: "personal", plan: "pro", status: "active" };
  const enterprise = { id: "enterprise", plan: "enterprise", status: "trialing" };

  assert.equal(resolveEnterpriseWorkspaceForOnboarding(null, [personal, enterprise]), enterprise);
  assert.equal(resolveEnterpriseWorkspaceForOnboarding(personal, [personal, enterprise]), null);
  assert.equal(
    resolveEnterpriseWorkspaceForOnboarding(enterprise, [personal, enterprise]),
    enterprise
  );
});

test("versioned sessions reject malformed or old data", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  assert.equal(parseOnboardingSession(null), null);
  assert.equal(parseOnboardingSession("not json"), null);
  assert.equal(parseOnboardingSession('{"version":1,"currentStepId":"auth"}'), null);

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
  session.resume.auth = {
    ...session.resume.auth,
    authMode: "sign-up",
    email: "person@example.com",
    fullName: "Person Example",
  };
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
  malformedDraft.resume.auth.authMode = "unknown";
  malformedDraft.resume.byok["byok-dictation"].selectedProvider = 42;
  malformedDraft.resume.localModels["local-assistant"].modelId = false;
  const parsed = parseOnboardingSession(JSON.stringify(malformedDraft));
  assert.equal(parsed.resume.auth.authMode, null);
  assert.equal(parsed.resume.byok["byok-dictation"].selectedProvider, "");
  assert.equal(parsed.resume.localModels["local-assistant"].modelId, "");
});

test("an explicit restart clears every persisted route choice and returns to auth", async () => {
  const { resetOnboardingProgress } = await load();
  const values = new Map([
    ["onboardingSessionV2", '{"currentStepId":"permissions"}'],
    ["onboardingCompleted", "true"],
    ["authenticationSkipped", "true"],
    ["skipAuth", "true"],
    ["localSetupPending", "true"],
    ["pendingLocalModelSelectionsV1", '{"assistant":{"provider":"qwen","modelId":"qwen-9b"}}'],
    ["signInPromptedAt", "1700000000000"],
  ]);
  const storage = {
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  resetOnboardingProgress(storage);

  assert.equal(values.get("onboardingCurrentStep"), "0");
  assert.equal(values.has("onboardingSessionV2"), false);
  assert.equal(values.has("onboardingCompleted"), false);
  assert.equal(values.has("authenticationSkipped"), false);
  assert.equal(values.has("skipAuth"), false);
  assert.equal(values.has("localSetupPending"), false);
  assert.equal(values.has("pendingLocalModelSelectionsV1"), false);
  assert.equal(values.has("signInPromptedAt"), false, "a restart is not a sign-in");
});

test("legacy numeric steps migrate conservatively", async () => {
  const { migrateLegacyOnboardingStep } = await load();
  assert.equal(migrateLegacyOnboardingStep(null), "auth");
  assert.equal(migrateLegacyOnboardingStep("0"), "auth");
  // Old steps 1-2 predate the old permissions step, so they must resume at
  // the new flow's permissions step rather than past it.
  assert.equal(migrateLegacyOnboardingStep("1"), "permissions");
  assert.equal(migrateLegacyOnboardingStep("2"), "permissions");
  assert.equal(migrateLegacyOnboardingStep("4"), "dictation-hotkey");
  assert.equal(migrateLegacyOnboardingStep("999"), "setup-choice");
});

test("route helpers recover from ineligible steps", async () => {
  const { getNextOnboardingStep, getOnboardingRoute, reconcileStepWithRoute } = await load();
  const route = getOnboardingRoute({ authPath: "guest", setupMode: null });
  assert.equal(reconcileStepWithRoute("assistant-demo", route), "setup-choice");
  assert.equal(getNextOnboardingStep("auth", route), "permissions");
  assert.equal(getNextOnboardingStep("setup-choice", route), null);
});

test("progress counts every step the user is shown, once each", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ authPath: "account", setupMode: null });

  // The compact steps render in a frame with no footer, so they carry no row and
  // must not inflate the total — landing on languages is "1 of 8", not "3 of 10".
  assert.equal(getOnboardingProgress("auth", route), null);
  assert.equal(getOnboardingProgress("permissions", route), null);

  const counted = route.filter((stepId) => getOnboardingProgress(stepId, route) !== null);
  assert.deepEqual(
    counted.map((stepId) => getOnboardingProgress(stepId, route).index),
    counted.map((_, index) => index)
  );
  assert.deepEqual(getOnboardingProgress("languages", route), { index: 0, total: 8 });
  assert.deepEqual(getOnboardingProgress("setup-choice", route), { index: 7, total: 8 });
});

test("progress total tracks the conditional parts of the route", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  const context = { authPath: "account", setupMode: null };

  // Picking a non-cloud mode appends the provider pair, so the row grows by two
  // at that moment and the last provider step is what fills it.
  const byok = getOnboardingRoute({ ...context, setupMode: "byok" });
  assert.deepEqual(getOnboardingProgress("setup-choice", byok), { index: 7, total: 10 });
  assert.deepEqual(getOnboardingProgress("byok-assistant", byok), { index: 9, total: 10 });
});

test("progress counts only the guest steps that draw a footer", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  // auth and permissions are compact, so the pre-plan guest route counts
  // dictation-hotkey and setup-choice: a two-dot row.
  const guest = getOnboardingRoute({ authPath: "guest", setupMode: null });
  assert.deepEqual(getOnboardingProgress("setup-choice", guest), { index: 1, total: 2 });

  const guestByok = getOnboardingRoute({
    authPath: "guest",
    setupMode: "byok",
  });
  assert.deepEqual(getOnboardingProgress("setup-choice", guestByok), { index: 1, total: 4 });

  // An off-route step has no position to report.
  assert.equal(getOnboardingProgress("notes", guestByok), null);
});

test("a session written before the resume flags infers its hotkey confirmations", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const preResumeSession = (currentStepId) => {
    const { resume, ...session } = { ...createOnboardingSession(), currentStepId };
    void resume;
    return JSON.stringify({ ...session, authPath: "account" });
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
