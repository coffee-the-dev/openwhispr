import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { AudioLines, Check, CircleCheck, Download, MousePointer2 } from "../icons";
import { useTranslation } from "react-i18next";
import { FieldLabel, ProviderCheckField } from "../ui/ProviderCheckField";
import { ConnectionCheckAnnouncer } from "../ui/ConnectionCheckAnnouncer";
import { Button } from "../ui/button";
import { ProviderIcon } from "../ui/ProviderIcon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useConnectionAutoCheck } from "../../hooks/useConnectionAutoCheck";
import { isWindowSwitchBlur } from "../../hooks/useFocusHold";
import { useModelDownload } from "../../hooks/useModelDownload";
import type { ParakeetCheckResult } from "../../types/electron";
import { useSettingsStore } from "../../stores/settingsStore";
import { normalizeBaseUrl } from "../../config/constants";
import { withHttpsScheme } from "../../utils/urlUtils";
import { getParakeetModels, getWhisperModels, modelRegistry } from "../../models/ModelRegistry";
import {
  LOCAL_ASR_ORGANIZATIONS,
  getASRModelOrganization,
  getSelectedASROrganization,
  usesParakeetManager,
  DEFAULT_LOCAL_ASR_SELECTION,
} from "../../helpers/localASROrganization";
import {
  RESUME_DRAFT_PERSIST_DELAY_MS,
  type OnboardingLocalModelDraft,
  type OnboardingSelfHostedDraft,
  type OnboardingSelfHostedStepId,
  type OnboardingStepId,
} from "./flow";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import {
  forgetPendingLocalModel,
  isPendingLocalModel,
  readPendingLocalModels,
  rememberPendingLocalModel,
} from "./pendingLocalModels";
import { isLocalStageDownloadActive } from "./localDownloadState";
import { isBlankSelfHostedDraft, resolveSavedSelfHostedDraft } from "./savedSelfHostedConfig";
import OpenAICompatiblePanel from "../OpenAICompatiblePanel";

export function SetupStageStepper({ stepId }: { stepId: OnboardingStepId }) {
  const { t } = useTranslation();
  const assistant = stepId.endsWith("assistant");
  return (
    <div
      className="relative mx-auto flex items-start justify-between w-40"
      aria-label={t("onboarding.rehaul.provider.progress")}
    >
      <span className="absolute left-8 right-8 border-t border-dashed border-[var(--onboarding-control-border)] top-4" />
      <div className="relative z-10 flex w-14 flex-col items-center gap-1.5 text-[var(--onboarding-text-secondary)]">
        <span
          className={`flex items-center justify-center rounded-full size-8 ${
            assistant
              ? "bg-[var(--onboarding-accent)] text-[var(--onboarding-accent-foreground)]"
              : "bg-[var(--onboarding-inverse-surface)] text-[var(--onboarding-inverse-text)]"
          }`}
        >
          {assistant ? (
            <CircleCheck className="size-4" strokeWidth={2} />
          ) : (
            <AudioLines className="size-4" />
          )}
        </span>
        <span className="text-xs">{t("onboarding.rehaul.provider.dictation")}</span>
      </div>
      <div className="relative z-10 flex w-14 flex-col items-center gap-1.5 text-[var(--onboarding-text-secondary)]">
        <span
          className={`flex items-center justify-center rounded-full size-8 ${
            assistant
              ? "bg-[var(--onboarding-inverse-surface)] text-[var(--onboarding-inverse-text)]"
              : "border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-[var(--onboarding-text-primary)]"
          }`}
        >
          <MousePointer2 className="size-4" />
        </span>
        <span className="text-xs">{t("onboarding.rehaul.provider.assistant")}</span>
      </div>
    </div>
  );
}

/**
 * The card actions run on the same two pills as the shell footer (Figma
 * "Frame 25" and "Frame 32"): 40 tall, radius 38, Inter Medium 14/140%, the
 * primary on the onboarding accent and the secondary stroke-only on
 * light/surface-stroke. Before this, each card carried its own hand-rolled
 * 32px-tall button — some on blue-500, some on neutral-950, all at regular
 * weight — so the step's own call to action read quieter than the Continue
 * button sitting right under it.
 */
function StepPrimaryAction({
  onClick,
  disabled = false,
  className = "",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-9 rounded-[38px] px-5 text-sm ${className}`}
    >
      {children}
    </Button>
  );
}

function StepSecondaryAction({
  onClick,
  disabled = false,
  className = "",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline-flat"
      onClick={onClick}
      disabled={disabled}
      className={`h-9 rounded-[38px]! border! border-[var(--onboarding-control-border)]! bg-transparent! px-5 text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)] shadow-none! hover:bg-[var(--onboarding-surface-hover)]! ${className}`}
    >
      {children}
    </Button>
  );
}

/** The card each setup mode's step renders into. Top margin is per call site. */
const SETUP_CARD_BASE_CLASS =
  "mx-auto w-full rounded-[1.125rem] border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-[var(--onboarding-text-primary)]";

export const SETUP_CARD_CLASS = `${SETUP_CARD_BASE_CLASS} max-w-[30rem] px-3 py-4`;
const LOCAL_MODEL_CARD_CLASS = `${SETUP_CARD_BASE_CLASS} max-w-[30rem] px-4 py-4`;

/** The field trigger. Call sites that can be disabled add the disabled: variants. */
const SELECT_TRIGGER_CLASS =
  "h-9 rounded-xl border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface-secondary)] px-3 text-xs text-[var(--onboarding-text-primary)]";
const LOCAL_SELECT_TRIGGER_CLASS =
  "h-12 rounded-xl border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface-secondary)] px-3 text-sm text-[var(--onboarding-text-primary)]";

/**
 * The dropdown sheet, Figma "Onboarding / Frame 16": radius 17 on
 * light/surface-stroke, 12 pad, `0 3 7.3 #0000001F` shadow. Radix's viewport
 * carries its own 4px pad, which would stack with the panel's — zero it and let
 * the panel own the inset, so the rows run edge to edge inside it and the
 * scrollbar (styled in index.css) sits in the panel's gutter.
 *
 * The 12 of inset is split 6 here and 6 on the row, the same way
 * .onboarding-list-scroll splits its 4 with .onboarding-list-row: labels still
 * land 12 from the panel edge, and the 6 is the breathing room the row's hover
 * slab needs so it reads as a slab and not as a full-bleed band. Vertical drops
 * to 8 because the rows keep their own 12 at the ends now (see below).
 *
 * Every colour here is an --onboarding-* token rather than a literal, which is
 * what lets the panel follow the theme from out here: it portals to document.body,
 * outside .onboarding-canvas, and the token block in index.css is scoped to
 * `body:has(.onboarding-canvas)` for exactly this case. It used to carry `dark:`
 * copies of the light values instead, to pin the sheet light while onboarding was
 * light-only.
 */
const SELECT_PANEL_CLASS =
  "onboarding-select-panel rounded-[17px] border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-1.5 py-2 text-[var(--onboarding-text-primary)] shadow-[0_3px_7.3px_0_rgba(0,0,0,0.12)] [&_[data-radix-select-viewport]]:p-0";

/**
 * A row from the same frame: 12 of vertical padding, 20px mark at gap 10, label
 * Inter Medium 16/140%.
 *
 * The dividers and the rounded hover slab live in `.onboarding-select-item`
 * (index.css) so they can behave the way .onboarding-list-row's do — hairlines
 * separate rows rather than bounding them, and a hovered row's slab swallows its
 * own rule and the next one's. Unlike the old `first:pt-0 last:pb-0`, the end rows
 * keep their padding: dropping it would leave the first and last slab shorter than
 * every other one. The panel's vertical inset absorbs that instead.
 *
 * The bg-transparent variants neutralise the base SelectItem's theme-bound fills
 * (`hover:bg-muted`, `dark:hover:bg-primary/8`), which resolve against the app
 * theme out here and would paint a square band behind the slab.
 */
const SELECT_ITEM_CLASS =
  "onboarding-select-item gap-2.5 rounded-none py-2.5 ps-1.5 pe-8 text-sm font-normal leading-[1.4] hover:bg-transparent focus:bg-transparent data-highlighted:bg-transparent dark:hover:bg-transparent dark:focus:bg-transparent dark:data-highlighted:bg-transparent [&>span:nth-child(2)]:w-full";

/**
 * One server's variants — missing scheme, host case, trailing slash, pasted API path —
 * compare equal. Parsing lowercases the scheme and host; the path keeps its case.
 */
function endpointIdentity(baseUrl: string): string {
  const normalized = normalizeBaseUrl(withHttpsScheme(baseUrl));
  try {
    return new URL(normalized).href;
  } catch {
    return normalized;
  }
}

function isSameEndpoint(baseUrl: string, savedBaseUrl: string): boolean {
  const saved = endpointIdentity(savedBaseUrl);
  return Boolean(saved) && endpointIdentity(baseUrl) === saved;
}

/**
 * The provider/model a local step opens on: the draft this step last wrote, then
 * a selection whose download is still pending, then whatever the store already
 * holds. Reads localStorage, so it belongs in a state initializer, not a render.
 */
function resolveInitialLocalSelection(
  assistant: boolean,
  resumeState: OnboardingLocalModelDraft | undefined,
  store: ReturnType<typeof useSettingsStore.getState>
): OnboardingLocalModelDraft {
  const pending = readPendingLocalModels()[assistant ? "assistant" : "dictation"];
  // A fresh install has never picked a local provider (the store only falls back
  // to whisper); open on the recommended Oruk model instead of that fallback.
  const hasChosenLocalASR =
    !!store.parakeetModel || localStorage.getItem("localTranscriptionProvider") !== null;
  if (!assistant && !resumeState && !pending && !hasChosenLocalASR) {
    return DEFAULT_LOCAL_ASR_SELECTION;
  }
  const savedProvider = assistant
    ? modelRegistry.getProvider(store.chatAgentProvider)
      ? store.chatAgentProvider
      : "qwen"
    : getSelectedASROrganization(store.localTranscriptionProvider, store.parakeetModel);
  const resumeProvider = resumeState
    ? getSelectedASROrganization(resumeState.provider, resumeState.modelId)
    : undefined;
  const pendingProvider = pending
    ? getSelectedASROrganization(pending.provider, pending.modelId)
    : undefined;
  const requestedProvider = resumeProvider || pendingProvider || savedProvider;
  const provider = assistant
    ? modelRegistry.getProvider(requestedProvider)
      ? requestedProvider
      : "qwen"
    : requestedProvider === "nvidia" || requestedProvider === "oruk"
      ? requestedProvider
      : "whisper";
  const savedModel = assistant
    ? store.chatAgentModel
    : usesParakeetManager(provider)
      ? store.parakeetModel
      : store.whisperModel;

  return {
    provider,
    modelId:
      (resumeProvider === provider ? resumeState?.modelId : "") ||
      (pendingProvider === provider ? pending?.modelId : "") ||
      savedModel,
  };
}

export function SelfHostedSetupStep({
  stepId,
  onReadinessChange,
  onProceed,
  resumeState,
  onResumeStateChange,
}: {
  stepId: OnboardingSelfHostedStepId;
  onReadinessChange: (ready: boolean) => void;
  onProceed: () => void;
  resumeState?: OnboardingSelfHostedDraft;
  onResumeStateChange?: (state: OnboardingSelfHostedDraft) => void;
}) {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const assistant = stepId === "self-hosted-assistant";
  // The session's draft wins; without one (onboarding was restarted) the step
  // reopens on what the user already saved. The draft never records keys, so the
  // stored key is tracked by the server it was saved under — the draft, and
  // anything typed after it, can name a different server than the settings do.
  const [seed] = useState(() => {
    const saved = resolveSavedSelfHostedDraft(stepId, store);
    const draft = resumeState && !isBlankSelfHostedDraft(resumeState) ? resumeState : saved;
    return {
      baseUrl: draft?.baseUrl ?? "",
      model: draft?.model ?? "",
      keyedBaseUrl: saved?.baseUrl ?? "",
    };
  });
  // The stored key belongs to the one server it was saved under: offering it for
  // a first setup or a server the user has since typed would send a key they
  // never typed to that server.
  const storedKey = assistant ? store.chatAgentCustomApiKey : store.customTranscriptionApiKey;
  const savedKeyFor = (baseUrl: string) =>
    isSameEndpoint(baseUrl, seed.keyedBaseUrl) ? storedKey : "";
  const [draftBaseUrl, setDraftBaseUrl] = useState(seed.baseUrl);
  const [draftApiKey, setDraftApiKey] = useState(() => savedKeyFor(seed.baseUrl));
  const [draftModel, setDraftModel] = useState(seed.model);
  const [endpointFocused, setEndpointFocused] = useState(false);

  // Base URL and model are typed, so the write is debounced; the flush covers
  // the pending write this card drops when the step advances and unmounts it.
  const latestDraft = useRef<OnboardingSelfHostedDraft | null>(null);
  const flushDraft = useCallback(() => {
    if (latestDraft.current) onResumeStateChange?.(latestDraft.current);
  }, [onResumeStateChange]);
  const persistDraft = useDebouncedCallback(flushDraft, RESUME_DRAFT_PERSIST_DELAY_MS);

  useEffect(() => {
    latestDraft.current = { baseUrl: draftBaseUrl, model: draftModel };
    persistDraft();
  }, [draftBaseUrl, draftModel, persistDraft]);

  useEffect(() => flushDraft, [flushDraft]);

  // Saved keys load asynchronously (initializeSettings), so an empty field takes
  // its key when it arrives; anything already in the field is kept. Retyping the
  // server takes a prefilled copy of the stored key back out — never a key the
  // user typed.
  const savedKey = savedKeyFor(draftBaseUrl);
  useEffect(() => {
    if (savedKey) setDraftApiKey((current) => current || savedKey);
    else if (storedKey) setDraftApiKey((current) => (current === storedKey ? "" : current));
  }, [savedKey, storedKey]);

  // Dictation proves its server with the automatic check; the assistant's model
  // list is fetched from the server itself, so a picked model is the proof.
  const check = useConnectionAutoCheck({
    config: {
      scope: "transcription",
      provider: "custom",
      apiKey: draftApiKey,
      baseUrl: draftBaseUrl,
      model: draftModel.trim() || undefined,
    },
    ready: !assistant && Boolean(draftBaseUrl.trim()),
    // A half-typed address may belong to someone else: nothing is sent while it is edited.
    hold: endpointFocused,
  });
  // A server that gave no verdict (busy, slow or unreachable) refused nothing, so its
  // setup can be used; only a failure that faults it keeps Proceed locked.
  const ready = assistant
    ? Boolean(draftBaseUrl.trim() && draftModel.trim())
    : check.phase === "connected" || check.phase === "unverified";

  useEffect(() => {
    onReadinessChange(ready);
  }, [onReadinessChange, ready]);

  // Switching to another app blurs the field but leaves it focused in the page, and the
  // address there may still be half typed.
  const releaseEndpoint = (event: FocusEvent<HTMLInputElement>) => {
    if (!isWindowSwitchBlur(event)) setEndpointFocused(false);
  };

  const commitAndProceed = () => {
    const committedBaseUrl = withHttpsScheme(draftBaseUrl);
    if (assistant) {
      store.setChatAgentMode("self-hosted");
      store.setChatAgentProvider("lan");
      store.setChatAgentRemoteUrl(committedBaseUrl);
      store.setChatAgentCustomApiKey(draftApiKey);
      store.setChatAgentModel(draftModel);
    } else {
      store.setRemoteTranscriptionUrl(committedBaseUrl);
      store.setRemoteTranscriptionModel(draftModel);
      store.setRemoteTranscriptionType("openai-compatible");
      store.setCustomTranscriptionApiKey(draftApiKey);
    }
    onProceed();
  };

  return (
    <section className={`mt-5 ${SETUP_CARD_CLASS}`}>
      <SetupStageStepper stepId={stepId} />

      <div className="mt-3 space-y-3">
        {assistant ? (
          <OpenAICompatiblePanel
            baseUrl={draftBaseUrl}
            setBaseUrl={setDraftBaseUrl}
            apiKey={draftApiKey}
            setApiKey={setDraftApiKey}
            model={draftModel}
            setModel={setDraftModel}
          />
        ) : (
          <>
            <ProviderCheckField
              label={t("onboarding.rehaul.provider.endpointUrl")}
              value={draftBaseUrl}
              onChange={(event) => setDraftBaseUrl(event.target.value)}
              onFocus={() => setEndpointFocused(true)}
              onBlur={releaseEndpoint}
              placeholder={t("onboarding.rehaul.provider.endpointPlaceholder")}
            />
            <ProviderCheckField
              label={t("onboarding.rehaul.provider.apiKey")}
              type="password"
              value={draftApiKey}
              onChange={(event) => setDraftApiKey(event.target.value)}
              placeholder={t("onboarding.rehaul.provider.optional")}
              autoComplete="off"
              spellCheck={false}
            />
            <ProviderCheckField
              label={t("onboarding.rehaul.provider.modelId")}
              check={check}
              invalidOn="modelNotFound"
              value={draftModel}
              onChange={(event) => setDraftModel(event.target.value)}
              placeholder={t("onboarding.rehaul.provider.optional")}
            />
          </>
        )}

        <StepPrimaryAction onClick={commitAndProceed} disabled={!ready} className="mt-4! w-full">
          {t("onboarding.rehaul.provider.proceed")}
        </StepPrimaryAction>
      </div>

      <ConnectionCheckAnnouncer announcement={check.announcement} />
    </section>
  );
}

export function LocalModelSetupStep({
  stepId,
  onReadinessChange,
  onProceed,
  onSkip,
  resumeState,
  onResumeStateChange,
}: {
  stepId: "local-dictation" | "local-assistant";
  onReadinessChange: (ready: boolean) => void;
  onProceed: () => void;
  onSkip: () => void;
  resumeState?: OnboardingLocalModelDraft;
  onResumeStateChange?: (state: OnboardingLocalModelDraft) => void;
}) {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const assistant = stepId === "local-assistant";
  const [initialSelection] = useState(() =>
    resolveInitialLocalSelection(assistant, resumeState, store)
  );
  const [selectedProvider, setSelectedProvider] = useState(initialSelection.provider);
  const [selectedModel, setSelectedModel] = useState(initialSelection.modelId);
  const [downloadedWhisper, setDownloadedWhisper] = useState<Set<string>>(new Set());
  const [downloadedParakeet, setDownloadedParakeet] = useState<Set<string>>(new Set());
  const [downloadedLlm, setDownloadedLlm] = useState<Set<string>>(new Set());
  const [parakeetCapability, setParakeetCapability] = useState<ParakeetCheckResult | null>(null);
  const parakeetUnavailable = !assistant && parakeetCapability?.supported === false;

  useEffect(() => {
    if (assistant) return;
    let cancelled = false;
    window.electronAPI
      ?.checkParakeetInstallation?.()
      .then((capability) => {
        if (!cancelled) setParakeetCapability(capability);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [assistant]);

  useEffect(() => {
    if (parakeetUnavailable && usesParakeetManager(selectedProvider)) {
      setSelectedProvider("whisper");
      setSelectedModel("");
    }
  }, [parakeetUnavailable, selectedProvider]);

  const refreshDownloadedModels = useCallback(async () => {
    const [whisper, parakeet, llm] = await Promise.all([
      window.electronAPI?.listWhisperModels?.().catch(() => undefined),
      window.electronAPI?.listParakeetModels?.().catch(() => undefined),
      window.electronAPI?.modelGetAll?.().catch(() => undefined),
    ]);
    setDownloadedWhisper(
      new Set(
        (whisper?.models ?? []).filter((model) => model.downloaded).map((model) => model.model)
      )
    );
    setDownloadedParakeet(
      new Set(
        (parakeet?.models ?? []).filter((model) => model.downloaded).map((model) => model.model)
      )
    );
    setDownloadedLlm(
      new Set((llm ?? []).filter((model) => model.isDownloaded).map((model) => model.id))
    );
  }, []);

  const whisperDownload = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: refreshDownloadedModels,
  });
  const parakeetDownload = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: refreshDownloadedModels,
  });
  const llmDownload = useModelDownload({
    modelType: "llm",
    onDownloadComplete: refreshDownloadedModels,
  });

  useEffect(() => {
    void refreshDownloadedModels();
  }, [refreshDownloadedModels]);

  const providerOptions = useMemo(() => {
    if (assistant) {
      return modelRegistry.getAllProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        icon: provider.id,
      }));
    }
    return LOCAL_ASR_ORGANIZATIONS.filter((organization) => organization.id !== "cohere").map(
      (organization) => ({
        ...organization,
        icon: organization.id === "whisper" ? "openai" : organization.id,
      })
    );
  }, [assistant]);

  const models = useMemo(() => {
    if (assistant) {
      return (modelRegistry.getProvider(selectedProvider)?.models ?? []).map((model) => ({
        id: model.id,
        name: model.name,
        size: model.size,
        recommended: model.recommended,
        icon: selectedProvider,
      }));
    }
    if (usesParakeetManager(selectedProvider)) {
      return Object.entries(getParakeetModels())
        .filter(([id]) => getASRModelOrganization(id) === selectedProvider)
        .map(([id, model]) => ({
          id,
          name: model.name,
          size: model.size.replace(/(?<=\d)(?=[A-Za-z])/, " "),
          recommended: model.recommended,
          icon: selectedProvider,
        }));
    }
    return Object.entries(getWhisperModels()).map(([id, model]) => ({
      id,
      name: model.name,
      size: model.size.replace(/(?<=\d)(?=[A-Za-z])/, " "),
      recommended: model.recommended,
      icon: "openai",
    }));
  }, [assistant, selectedProvider]);

  useEffect(() => {
    if (selectedModel && !models.some((model) => model.id === selectedModel)) {
      setSelectedModel("");
    }
  }, [models, selectedModel]);

  useEffect(() => {
    onResumeStateChange?.({ provider: selectedProvider, modelId: selectedModel });
  }, [onResumeStateChange, selectedModel, selectedProvider]);

  const currentProvider = providerOptions.find((provider) => provider.id === selectedProvider);
  const activeDownload = assistant
    ? llmDownload
    : usesParakeetManager(selectedProvider)
      ? parakeetDownload
      : whisperDownload;
  const downloadedModels = assistant
    ? downloadedLlm
    : usesParakeetManager(selectedProvider)
      ? downloadedParakeet
      : downloadedWhisper;
  const selectedReady = Boolean(
    selectedModel &&
    downloadedModels.has(selectedModel) &&
    !(parakeetUnavailable && usesParakeetManager(selectedProvider))
  );

  useEffect(() => {
    onReadinessChange(selectedReady);
  }, [onReadinessChange, selectedReady]);

  const selectInstalledModel = useCallback(
    (modelId: string): void => {
      if (parakeetUnavailable && usesParakeetManager(selectedProvider)) return;
      const kind = assistant ? "assistant" : "dictation";
      setSelectedModel(modelId);
      if (assistant) {
        store.setChatAgentMode("local");
        store.setChatAgentProvider(selectedProvider);
        store.setChatAgentModel(modelId);
      } else if (usesParakeetManager(selectedProvider)) {
        store.setLocalTranscriptionProvider("nvidia");
        store.setParakeetModel(modelId);
      } else {
        store.setLocalTranscriptionProvider("whisper");
        store.setWhisperModel(modelId);
      }
      if (localStorage.getItem("localSetupPending") !== "true") {
        forgetPendingLocalModel(kind, modelId);
      }
    },
    [assistant, parakeetUnavailable, selectedProvider, store]
  );

  const chooseInstalledModel = (modelId: string): void => {
    forgetPendingLocalModel(assistant ? "assistant" : "dictation");
    selectInstalledModel(modelId);
  };

  const downloadModel = (modelId: string): void => {
    if (parakeetUnavailable && usesParakeetManager(selectedProvider)) return;
    const kind = assistant ? "assistant" : "dictation";
    // LLMs can download concurrently; a refused duplicate or native transfer
    // must not replace the selection waiting for an accepted download.
    if (
      !activeDownload.isDownloadingModel(modelId) &&
      (assistant || !activeDownload.isDownloading)
    ) {
      rememberPendingLocalModel(kind, {
        provider: selectedProvider === "oruk" ? "nvidia" : selectedProvider,
        modelId,
      });
    }
    void activeDownload.downloadModel(modelId, (downloadedId): void => {
      if (
        isPendingLocalModel(kind, {
          provider: selectedProvider === "oruk" ? "nvidia" : selectedProvider,
          modelId: downloadedId,
        })
      ) {
        selectInstalledModel(downloadedId);
        return;
      }
      if (readPendingLocalModels()[kind]) return;

      // The tray can activate and consume this selection before the initiating
      // IPC resolves. Reflect that activation without replacing a newer choice.
      const saved = useSettingsStore.getState();
      const alreadySelected = assistant
        ? saved.chatAgentMode === "local" &&
          saved.chatAgentProvider === selectedProvider &&
          saved.chatAgentModel === downloadedId
        : getSelectedASROrganization(saved.localTranscriptionProvider, saved.parakeetModel) ===
            selectedProvider &&
          (usesParakeetManager(selectedProvider) ? saved.parakeetModel : saved.whisperModel) ===
            downloadedId;
      if (alreadySelected) setSelectedModel(downloadedId);
    });
  };

  const chooseProvider = (providerId: string) => {
    if (parakeetUnavailable && usesParakeetManager(providerId)) return;
    setSelectedProvider(providerId);
    setSelectedModel("");
    onReadinessChange(false);
  };

  const anyDownloadActive = isLocalStageDownloadActive(assistant ? "assistant" : "dictation", {
    whisper: whisperDownload.isDownloading,
    parakeet: parakeetDownload.isDownloading,
    llm: llmDownload.isDownloading,
  });
  const pendingSelection = readPendingLocalModels()[assistant ? "assistant" : "dictation"];
  const pendingDownload = assistant
    ? llmDownload
    : pendingSelection?.provider === "nvidia"
      ? parakeetDownload
      : whisperDownload;
  // Only the pending selection will activate in the background. Other transfers
  // can outlive it when the user cancels the newest of several downloads.
  const hasPendingDownload = Boolean(
    pendingSelection && pendingDownload.isDownloadingModel(pendingSelection.modelId)
  );
  const canProceed = selectedReady || hasPendingDownload;
  const showSkip = anyDownloadActive || (assistant && !selectedReady);

  const proceed = () => {
    // Leaving mid-download is the same situation as "download in background":
    // this step unmounts, so the tray is what finishes the job, and it only
    // applies the pending selection while localSetupPending is set.
    if (hasPendingDownload && !selectedReady) {
      localStorage.setItem("localSetupPending", "true");
    }
    onProceed();
  };

  const skip = () => {
    localStorage.setItem("localSetupPending", "true");
    onSkip();
  };

  return (
    <section className={`mt-8 ${LOCAL_MODEL_CARD_CLASS}`}>
      <SetupStageStepper stepId={stepId} />

      <div className="mt-6">
        <FieldLabel>{t("onboarding.rehaul.local.providerLabel")}</FieldLabel>
        <Select value={selectedProvider} onValueChange={chooseProvider}>
          <SelectTrigger className={LOCAL_SELECT_TRIGGER_CLASS}>
            <span>{currentProvider?.name ?? selectedProvider}</span>
          </SelectTrigger>
          <SelectContent className={`max-h-[14.625rem] ${SELECT_PANEL_CLASS}`}>
            {providerOptions.map((provider) => (
              <SelectItem
                key={provider.id}
                value={provider.id}
                className={SELECT_ITEM_CLASS}
                disabled={parakeetUnavailable && usesParakeetManager(provider.id)}
              >
                <span className="flex items-center gap-2.5">
                  <ProviderIcon
                    provider={provider.icon}
                    className="size-5"
                    monochrome={assistant && provider.id === "qwen"}
                  />
                  {provider.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {parakeetUnavailable && (
          <p className="mt-2 text-xs text-[var(--onboarding-text-secondary)]">
            {parakeetCapability.minimumMacOSVersion
              ? t("transcription.parakeet.requiresMacOS", {
                  version: parakeetCapability.minimumMacOSVersion,
                })
              : t("transcription.parakeet.unavailable")}
          </p>
        )}
      </div>

      {/* A fixed list height keeps the card and footer stable while the visible
          scrollbar makes additional provider models discoverable. */}
      <div className="onboarding-list-scroll mt-4 h-56 rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface-secondary)]">
        {models.map((model) => {
          const isDownloaded = downloadedModels.has(model.id);
          const download = activeDownload.downloads[model.id];
          const isDownloading = Boolean(download);
          const isSelected = selectedModel === model.id && isDownloaded;
          const percentage = Math.round(download?.progress ?? 0);
          return (
            <div
              key={model.id}
              className="flex min-h-20 items-center gap-3 border-b border-[var(--onboarding-control-border)] px-2 py-3 last:border-b-0"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)]">
                <ProviderIcon
                  provider={model.icon}
                  className="size-5"
                  monochrome={assistant && model.icon === "qwen"}
                />
              </span>
              <button
                type="button"
                disabled={!isDownloaded}
                onClick={() => chooseInstalledModel(model.id)}
                className="min-w-0 flex-1 rounded-lg text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_30%,transparent)] disabled:cursor-default"
              >
                <span className="block truncate text-base font-medium text-[var(--onboarding-text-primary)]">
                  {model.name}
                </span>
                <span className="mt-1 block truncate text-sm text-[var(--onboarding-text-secondary)]">
                  {model.size}
                  {!assistant && model.recommended && ` - ${t("common.recommended")}`}
                </span>
              </button>

              {isDownloading ? (
                // Figma "Frame 25": white pill, #E3E3E3 stroke, radius 38, 6/12
                // padding, gap 8, both labels Inter Medium 14/140% in
                // text-secondary. Progress is a light/surface-tertiary fill
                // growing from the left behind them, not a fixed-width segment
                // around the percentage.
                // No aria-live: BackgroundModelDownloadTray is the one live region
                // for download progress, so a second one here read every tick twice.
                <span className="relative flex h-8 shrink-0 items-center gap-2 overflow-hidden rounded-full border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-3 text-sm font-medium leading-[1.4] tabular-nums text-[var(--onboarding-text-secondary)]">
                  {/* Figma draws the rect taller than the pill so it bleeds top
                      and bottom; inset-y-0 does that without a magic height. */}
                  <span
                    className="absolute inset-y-0 start-0 bg-[var(--onboarding-surface-tertiary)] transition-[width] duration-300 ease-out"
                    style={{ width: `${percentage}%` }}
                    aria-hidden="true"
                  />
                  <span className="relative">{percentage}%</span>
                  <span className="relative whitespace-nowrap">
                    {download?.phase === "installing"
                      ? t("onboarding.rehaul.local.installing")
                      : t("onboarding.rehaul.local.downloadingShort")}
                  </span>
                </span>
              ) : isSelected ? (
                // Same token as the Use pill it replaces on click.
                <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[var(--onboarding-accent)] px-3 text-sm text-[var(--onboarding-accent-foreground)]">
                  <Check className="size-4" />
                  {t("onboarding.rehaul.local.selected")}
                </span>
              ) : isDownloaded ? (
                // Installed alternatives remain explicit primary actions until
                // they become the active selection.
                <Button
                  type="button"
                  onClick={() => chooseInstalledModel(model.id)}
                  className="h-8 gap-1.5 px-3 text-sm"
                >
                  {t("onboarding.rehaul.local.use")}
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => downloadModel(model.id)}
                  className="h-8 gap-1.5 px-3 text-sm"
                >
                  <Download className="size-3.5" />
                  {t("onboarding.rehaul.local.download")}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <div className={`mt-5 grid gap-2 ${showSkip ? "grid-cols-2" : "grid-cols-1"}`}>
        {/* On the assistant step, Skip also lets local-dictation users finish
            without configuring a cleanup model. */}
        {showSkip && (
          <StepSecondaryAction
            onClick={skip}
            disabled={!assistant && !canProceed}
            className="h-10!"
          >
            {t("common.skip")}
          </StepSecondaryAction>
        )}
        <StepPrimaryAction onClick={proceed} disabled={!canProceed} className="h-10!">
          {t("onboarding.rehaul.provider.proceed")}
        </StepPrimaryAction>
      </div>
    </section>
  );
}
