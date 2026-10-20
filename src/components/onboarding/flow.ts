import { PENDING_LOCAL_MODELS_KEY } from "./pendingLocalModels";
import type { PermissionGuideId } from "../../types/permissionGuide";

export const ONBOARDING_SESSION_KEY = "onboardingSessionV2";
export const LEGACY_ONBOARDING_STEP_KEY = "onboardingCurrentStep";
// Bumped when the route changes shape: a session saved under an older route
// (cloud or provider setup modes, steps this build no longer has) restarts
// from the first step rather than resuming somewhere it cannot finish.
export const ONBOARDING_FLOW_VERSION = 3;

/**
 * Resume drafts hold typed fields, and every write persists the whole session, so
 * the steps that own a text input write once per pause rather than per keystroke.
 */
export const RESUME_DRAFT_PERSIST_DELAY_MS = 400;

type OnboardingStorage = Pick<Storage, "removeItem">;

export type OnboardingStepId =
  | "permissions"
  | "languages"
  | "use-cases"
  | "dictation-hotkey"
  /** No longer routed — tap/hold lives on dictation-hotkey. Kept so a session
      saved on it still parses and reconciles onto its neighbour. */
  | "activation-mode"
  | "dictation-demo"
  | "assistant-hotkey"
  | "assistant-demo"
  | "notes"
  | "setup-choice"
  | "self-hosted-dictation"
  | "self-hosted-assistant"
  | "local-dictation"
  | "local-assistant";

export type OnboardingSetupMode = "local" | "self-hosted" | null;
export type OnboardingSelfHostedStepId = "self-hosted-dictation" | "self-hosted-assistant";
export type OnboardingLocalStepId = "local-dictation" | "local-assistant";

/** A self-hosted step's typed fields. The API key is never persisted here. */
export interface OnboardingSelfHostedDraft {
  baseUrl: string;
  model: string;
}

export interface OnboardingLocalModelDraft {
  provider: string;
  modelId: string;
}

export interface OnboardingResumeState {
  dictationHotkeyConfirmed: boolean;
  assistantHotkeyConfirmed: boolean;
  dictationDemoCompleted: boolean;
  assistantDemoCompleted: boolean;
  selfHosted: Partial<Record<OnboardingSelfHostedStepId, OnboardingSelfHostedDraft>>;
  localModels: Partial<Record<OnboardingLocalStepId, OnboardingLocalModelDraft>>;
}

export interface OnboardingSession {
  version: typeof ONBOARDING_FLOW_VERSION;
  currentStepId: OnboardingStepId;
  history: OnboardingStepId[];
  setupMode: OnboardingSetupMode;
  /**
   * The permissions step's screen-context Enable was clicked and the grant has
   * not landed yet. Persisted so the opt-in completes across the quit-and-reopen
   * macOS asks for after granting Screen Recording; cleared once consumed and
   * dropped with the session at finalization.
   */
  screenContextRequested: boolean;
  permissionGuide: PermissionGuideId | null;
  resume: OnboardingResumeState;
}

export interface OnboardingRouteContext {
  setupMode: OnboardingSetupMode;
}

// The permission grants and a hotkey the user has seen come first:
// finalizeOnboarding registers dictationHotkey, and skipping these steps
// shipped users who neither granted the mic nor knew their trigger key.
const BASE_ROUTE: OnboardingStepId[] = [
  "permissions",
  "languages",
  "use-cases",
  "dictation-hotkey",
  "setup-choice",
];

const SETUP_ROUTES: Record<Exclude<OnboardingSetupMode, null>, OnboardingStepId[]> = {
  local: ["local-dictation", "local-assistant"],
  "self-hosted": ["self-hosted-dictation", "self-hosted-assistant"],
};

// The practice steps run on the models the setup steps configured, so they
// only join the route once a setup mode is picked.
const PRACTICE_ROUTE: OnboardingStepId[] = [
  "dictation-demo",
  "notes",
  "assistant-hotkey",
  "assistant-demo",
];

// Canonical flow order, independent of any one route. reconcileStepWithRoute uses
// it to clamp backwards instead of jumping to the end of the route.
const STEP_ORDER: OnboardingStepId[] = [
  "permissions",
  "languages",
  "use-cases",
  "dictation-hotkey",
  "activation-mode",
  "setup-choice",
  "self-hosted-dictation",
  "self-hosted-assistant",
  "local-dictation",
  "local-assistant",
  "dictation-demo",
  "notes",
  "assistant-hotkey",
  "assistant-demo",
];

const KNOWN_STEPS = new Set<OnboardingStepId>(STEP_ORDER);

/**
 * Steps that render in the compact frame. That frame has no footer, so these
 * steps show no progress row and are left out of the count entirely — landing on
 * `languages` reads as "1 of N", not "3 of N" for two steps the user never saw a
 * counter on.
 */
export const COMPACT_STEPS: ReadonlySet<OnboardingStepId> = new Set<OnboardingStepId>([
  "permissions",
]);

const LEGACY_STEP_MAP: OnboardingStepId[] = [
  "permissions",
  // The old flow put permissions after these two indexes, so a save at 1-2
  // means the grants were never shown; the new route puts permissions first,
  // and resuming past it would skip the mic/accessibility prompts entirely.
  "permissions",
  "permissions",
  "permissions",
  "dictation-hotkey",
  // The old flow reached these before choosing a setup; the route now picks
  // the setup first, so they resume there.
  "setup-choice",
  "setup-choice",
  "setup-choice",
];

export function createOnboardingResumeState(): OnboardingResumeState {
  return {
    dictationHotkeyConfirmed: false,
    assistantHotkeyConfirmed: false,
    dictationDemoCompleted: false,
    assistantDemoCompleted: false,
    selfHosted: {},
    localModels: {},
  };
}

export function createOnboardingSession(): OnboardingSession {
  return {
    version: ONBOARDING_FLOW_VERSION,
    currentStepId: "permissions",
    history: [],
    setupMode: null,
    screenContextRequested: false,
    permissionGuide: null,
    resume: createOnboardingResumeState(),
  };
}

export function resetOnboardingProgress(storage: OnboardingStorage): void {
  storage.removeItem(ONBOARDING_SESSION_KEY);
  storage.removeItem(LEGACY_ONBOARDING_STEP_KEY);
  storage.removeItem("onboardingCompleted");
  storage.removeItem("localSetupPending");
  storage.removeItem(PENDING_LOCAL_MODELS_KEY);
}

export function getOnboardingRoute(context: OnboardingRouteContext): OnboardingStepId[] {
  return context.setupMode
    ? [...BASE_ROUTE, ...SETUP_ROUTES[context.setupMode], ...PRACTICE_ROUTE]
    : [...BASE_ROUTE];
}

/**
 * The Notes step's forward action. Calendar connections are optional, so the step
 * offers Skip until one connects and Continue afterwards.
 */
export function getNotesFooterAction({
  hasConnectedCalendar,
}: {
  hasConnectedCalendar: boolean;
}): "skip" | "continue" {
  return hasConnectedCalendar ? "continue" : "skip";
}

export function isOnboardingStepId(value: unknown): value is OnboardingStepId {
  return typeof value === "string" && KNOWN_STEPS.has(value as OnboardingStepId);
}

function isPermissionGuideId(value: unknown): value is PermissionGuideId {
  return (
    typeof value === "string" &&
    ["microphone", "accessibility", "system-audio", "screen-context"].includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readDraftString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseSelfHostedDraft(value: unknown): OnboardingSelfHostedDraft | undefined {
  if (!isRecord(value)) return undefined;
  return {
    baseUrl: readDraftString(value.baseUrl),
    model: readDraftString(value.model),
  };
}

function parseLocalModelDraft(value: unknown): OnboardingLocalModelDraft | undefined {
  if (!isRecord(value)) return undefined;
  return {
    provider: readDraftString(value.provider),
    modelId: readDraftString(value.modelId),
  };
}

/**
 * Sessions written before `resume` existed carry no confirmation flags, and
 * reading them as "never confirmed" is not safe: the hotkey flags decide whether
 * onboarding may replace a registered chord with the platform's onboarding one,
 * and finalizeOnboarding re-registers that on routes which never show the hotkey
 * step again. Having moved past the step is the evidence those builds left —
 * their Continue was gated on confirming.
 *
 * Only the hotkey flags are inferred. The demo flags gate nothing but a Continue
 * on the step the user is standing on, so guessing them would skip practice the
 * user never did.
 */
function inferResumeFlagsFromStep(currentStepId: OnboardingStepId): OnboardingResumeState {
  const isPast = (stepId: OnboardingStepId) =>
    STEP_ORDER.indexOf(currentStepId) > STEP_ORDER.indexOf(stepId);
  return {
    ...createOnboardingResumeState(),
    dictationHotkeyConfirmed: isPast("dictation-hotkey"),
    assistantHotkeyConfirmed: isPast("assistant-hotkey"),
  };
}

function parseOnboardingResumeState(
  value: unknown,
  currentStepId: OnboardingStepId
): OnboardingResumeState {
  if (value === undefined) return inferResumeFlagsFromStep(currentStepId);
  const defaults = createOnboardingResumeState();
  if (!isRecord(value)) return defaults;

  const selfHostedValue = isRecord(value.selfHosted) ? value.selfHosted : {};
  const localModelsValue = isRecord(value.localModels) ? value.localModels : {};
  const selfHostedDictation = parseSelfHostedDraft(selfHostedValue["self-hosted-dictation"]);
  const selfHostedAssistant = parseSelfHostedDraft(selfHostedValue["self-hosted-assistant"]);
  const localDictation = parseLocalModelDraft(localModelsValue["local-dictation"]);
  const localAssistant = parseLocalModelDraft(localModelsValue["local-assistant"]);

  return {
    dictationHotkeyConfirmed: value.dictationHotkeyConfirmed === true,
    assistantHotkeyConfirmed: value.assistantHotkeyConfirmed === true,
    dictationDemoCompleted: value.dictationDemoCompleted === true,
    assistantDemoCompleted: value.assistantDemoCompleted === true,
    selfHosted: {
      ...(selfHostedDictation ? { "self-hosted-dictation": selfHostedDictation } : {}),
      ...(selfHostedAssistant ? { "self-hosted-assistant": selfHostedAssistant } : {}),
    },
    localModels: {
      ...(localDictation ? { "local-dictation": localDictation } : {}),
      ...(localAssistant ? { "local-assistant": localAssistant } : {}),
    },
  };
}

export function parseOnboardingSession(value: string | null): OnboardingSession | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<OnboardingSession>;
    if (
      parsed.version !== ONBOARDING_FLOW_VERSION ||
      !isOnboardingStepId(parsed.currentStepId) ||
      !Array.isArray(parsed.history)
    ) {
      return null;
    }

    const rawSetupMode: unknown = parsed.setupMode;
    const setupMode =
      rawSetupMode === "local" || rawSetupMode === "self-hosted" ? rawSetupMode : null;
    if (
      parsed.screenContextRequested !== undefined &&
      typeof parsed.screenContextRequested !== "boolean"
    ) {
      return null;
    }

    return {
      version: ONBOARDING_FLOW_VERSION,
      currentStepId: parsed.currentStepId,
      history: parsed.history.filter(isOnboardingStepId),
      setupMode,
      screenContextRequested: parsed.screenContextRequested ?? false,
      permissionGuide: isPermissionGuideId(parsed.permissionGuide) ? parsed.permissionGuide : null,
      resume: parseOnboardingResumeState(parsed.resume, parsed.currentStepId),
    };
  } catch {
    return null;
  }
}

export function migrateLegacyOnboardingStep(value: string | null): OnboardingStepId {
  if (!value) return "permissions";
  if (isOnboardingStepId(value)) return value;

  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index) || index < 0) return "permissions";
  return LEGACY_STEP_MAP[Math.min(index, LEGACY_STEP_MAP.length - 1)] ?? "permissions";
}

/**
 * Map a step onto the caller's route, for when a saved session names a step the
 * current route no longer has (setupMode changes, or a dev jump asks for an
 * off-route step).
 *
 * Clamps to the route step nearest in the canonical order, ties going to the
 * earlier one so nothing gets skipped — falling back to the route's last step
 * would teleport past intermediate steps.
 */
export function reconcileStepWithRoute(
  stepId: OnboardingStepId,
  route: OnboardingStepId[]
): OnboardingStepId {
  if (route.includes(stepId)) return stepId;
  const target = STEP_ORDER.indexOf(stepId);
  if (target === -1 || route.length === 0) return route[0] ?? "permissions";
  return route.reduce((best, candidate) => {
    const bestDistance = Math.abs(STEP_ORDER.indexOf(best) - target);
    const candidateDistance = Math.abs(STEP_ORDER.indexOf(candidate) - target);
    return candidateDistance < bestDistance ? candidate : best;
  }, route[0]);
}

export function getNextOnboardingStep(
  currentStepId: OnboardingStepId,
  route: OnboardingStepId[]
): OnboardingStepId | null {
  const index = route.indexOf(currentStepId);
  return index >= 0 ? (route[index + 1] ?? null) : (route[0] ?? null);
}

export interface OnboardingProgressState {
  /** Zero-based position among the counted steps. */
  index: number;
  /** Number of counted steps in the current route. */
  total: number;
}

/**
 * Progress across the live route: one dot per step the user will actually see a
 * counter on, filled up to the current one.
 *
 * The total comes from the route rather than a constant because the route itself
 * is conditional — the setup pair and the practice steps only exist once a setup
 * mode is picked. Choosing local or self-hosted on setup-choice therefore appends
 * them and the row grows at that moment, which is the flow honestly getting longer.
 *
 * Returns null when there is nothing worth drawing: a compact step, an off-route
 * step, or a route with fewer than two counted steps, where a one-dot row would
 * read as decoration.
 */
export function getOnboardingProgress(
  stepId: OnboardingStepId,
  route: OnboardingStepId[]
): OnboardingProgressState | null {
  if (COMPACT_STEPS.has(stepId)) return null;

  const counted = route.filter((candidate) => !COMPACT_STEPS.has(candidate));
  const index = counted.indexOf(stepId);
  if (index === -1 || counted.length < 2) return null;

  return { index, total: counted.length };
}
