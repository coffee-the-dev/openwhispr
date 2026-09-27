import { PENDING_LOCAL_MODELS_KEY } from "./pendingLocalModels";

export const ONBOARDING_SESSION_KEY = "onboardingSessionV2";
export const LEGACY_ONBOARDING_STEP_KEY = "onboardingCurrentStep";
export const ONBOARDING_FLOW_VERSION = 2;

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
  | "byok-dictation"
  | "byok-assistant"
  | "local-dictation"
  | "local-assistant";

export type OnboardingSetupMode = "byok" | "local" | null;
export type OnboardingByokStepId = "byok-dictation" | "byok-assistant";
export type OnboardingLocalStepId = "local-dictation" | "local-assistant";

export interface OnboardingByokDraft {
  selectedProvider: string;
  selectedModel: string;
  baseUrl: string;
  customModel: string;
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
  byok: Partial<Record<OnboardingByokStepId, OnboardingByokDraft>>;
  localModels: Partial<Record<OnboardingLocalStepId, OnboardingLocalModelDraft>>;
}

export interface OnboardingSession {
  version: typeof ONBOARDING_FLOW_VERSION;
  currentStepId: OnboardingStepId;
  history: OnboardingStepId[];
  setupMode: OnboardingSetupMode;
  selfHostedRequested: boolean;
  /**
   * The permissions step's screen-context Enable was clicked and the grant has
   * not landed yet. Persisted so the opt-in completes across the quit-and-reopen
   * macOS asks for after granting Screen Recording; cleared once consumed and
   * dropped with the session at finalization.
   */
  screenContextRequested: boolean;
  resume: OnboardingResumeState;
}

export interface OnboardingRouteContext {
  setupMode: OnboardingSetupMode;
}

// The permission grants and a hotkey the user has seen come first:
// finalizeOnboarding registers dictationHotkey, and skipping these steps
// shipped users who neither granted the mic nor knew their trigger key.
const BASE_ROUTE: OnboardingStepId[] = ["permissions", "dictation-hotkey", "setup-choice"];

const SETUP_ROUTES: Record<Exclude<OnboardingSetupMode, null>, OnboardingStepId[]> = {
  byok: ["byok-dictation", "byok-assistant"],
  local: ["local-dictation", "local-assistant"],
};

// Canonical flow order, independent of any one route. reconcileStepWithRoute uses
// it to clamp backwards instead of jumping to the end of the route.
const STEP_ORDER: OnboardingStepId[] = [
  "permissions",
  "languages",
  "use-cases",
  "dictation-hotkey",
  "activation-mode",
  "dictation-demo",
  "notes",
  "assistant-hotkey",
  "assistant-demo",
  "setup-choice",
  "byok-dictation",
  "byok-assistant",
  "local-dictation",
  "local-assistant",
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
  "assistant-hotkey",
  "notes",
  "setup-choice",
];

export function createOnboardingResumeState(): OnboardingResumeState {
  return {
    dictationHotkeyConfirmed: false,
    assistantHotkeyConfirmed: false,
    dictationDemoCompleted: false,
    assistantDemoCompleted: false,
    byok: {},
    localModels: {},
  };
}

export function createOnboardingSession(): OnboardingSession {
  return {
    version: ONBOARDING_FLOW_VERSION,
    currentStepId: "permissions",
    history: [],
    setupMode: null,
    selfHostedRequested: false,
    screenContextRequested: false,
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
  return context.setupMode ? [...BASE_ROUTE, ...SETUP_ROUTES[context.setupMode]] : [...BASE_ROUTE];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readDraftString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseByokDraft(value: unknown): OnboardingByokDraft | undefined {
  if (!isRecord(value)) return undefined;
  return {
    selectedProvider: readDraftString(value.selectedProvider),
    selectedModel: readDraftString(value.selectedModel),
    baseUrl: readDraftString(value.baseUrl),
    customModel: readDraftString(value.customModel),
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

  const byokValue = isRecord(value.byok) ? value.byok : {};
  const localModelsValue = isRecord(value.localModels) ? value.localModels : {};
  const byokDictation = parseByokDraft(byokValue["byok-dictation"]);
  const byokAssistant = parseByokDraft(byokValue["byok-assistant"]);
  const localDictation = parseLocalModelDraft(localModelsValue["local-dictation"]);
  const localAssistant = parseLocalModelDraft(localModelsValue["local-assistant"]);

  return {
    dictationHotkeyConfirmed: value.dictationHotkeyConfirmed === true,
    assistantHotkeyConfirmed: value.assistantHotkeyConfirmed === true,
    dictationDemoCompleted: value.dictationDemoCompleted === true,
    assistantDemoCompleted: value.assistantDemoCompleted === true,
    byok: {
      ...(byokDictation ? { "byok-dictation": byokDictation } : {}),
      ...(byokAssistant ? { "byok-assistant": byokAssistant } : {}),
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

    // Sessions saved by builds with OpenWhispr Cloud may carry "cloud", which
    // this build cannot finish; they pick a setup again.
    const rawSetupMode: unknown = parsed.setupMode;
    const setupMode = rawSetupMode === "byok" || rawSetupMode === "local" ? rawSetupMode : null;
    if (
      parsed.selfHostedRequested !== undefined &&
      typeof parsed.selfHostedRequested !== "boolean"
    ) {
      return null;
    }
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
      selfHostedRequested: parsed.selfHostedRequested ?? false,
      screenContextRequested: parsed.screenContextRequested ?? false,
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
 * is conditional — the provider pair only exists once a setup mode is picked.
 * Choosing BYOK/local on setup-choice therefore appends two steps and the row
 * grows by two dots at that moment, which is the flow honestly getting longer.
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
