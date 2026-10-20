import ReasoningService from "../services/ReasoningService";
import {
  EMPTY_OUTPUT_MESSAGE_KEY,
  TRUNCATED_OUTPUT_MESSAGE_KEY,
} from "../services/ai/chatRequestBody";
import logger from "../utils/logger";
import { assertValidCleanupOutput } from "../utils/cleanupOutput";
import { getBaseLanguageCode, getLanguageLabel } from "../utils/languageSupport";
import { convertToWav, needsWavConversion } from "../utils/audioContainer";
import {
  applyChineseScript,
  mergeWhisperPrompt,
  resolveChineseScriptTarget,
  resolveCleanupLanguage,
} from "../utils/chineseScript";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
} from "./localSpeechGate";
import { reacquireIfDead } from "./micTrackHealth";
import { isMicWarm, WARMUP_ACQUIRE_TIMEOUT_MS } from "./micWarmState";
import {
  PreparedMicCapture,
  disposePreparedCapture,
  discardPreRoll,
  PRE_ROLL_MAX_AGE_MS,
} from "./preparedMicCapture";
import { MicStreamHold } from "./micStreamHold";
import { PcmTap } from "./pcmTap";
import { ActiveMicRecoveryController } from "./activeMicRecovery";
import { followsSystemDefaultMic } from "./micSelectionRecovery";
import { isCacheableMicrophoneResolution, resolvePreferredMicrophone } from "./microphoneSelection";
import { isStaleDeviceError } from "./staleMicDevice";
import { shouldSaveDiscardedRecording } from "./discardedRecording";
import { countSpokenWords, localDateKey, resolveAnalyticsMode } from "./analytics";
import { getSettings, useSettingsStore, selectResolvedLLMConfig } from "../stores/settingsStore";

import { isOnlineParakeetModel, isSherpaLocalProvider } from "../models/ModelRegistry";
import { resolveTranscriptionRoute } from "./transcriptionRoute.ts";
import { resolveSelfHostedTranscriptionModel } from "./selfHostedTranscription";
import { transcriptionFailureOutcome } from "./transcriptionFailureOutcome";
import { IPC_ERROR_FIELDS } from "./ipcErrorFields";
import { asProviderError, providerHttpError, redactProviderBody } from "./providerHttpErrors";
import {
  executeTranslationChain,
  hasTextContent,
  shouldRunTranslateStep,
} from "./translationChain";
import {
  detectAgentName,
  stripAgentAddress,
  stripAgentAddressPreservingFormatting,
} from "../config/agentDetection";
import {
  cleanupUnconfiguredNotice,
  resolveDictationRouteKind,
  resolveAgentImageTarget,
  resolveModeReachability,
  resolveWakeWordLanguage,
} from "./dictationRouting";
import { resolveDictationAgentInference, scopeAcceptsImages } from "./dictationAgentInference";
import { providerSupportsImages } from "../services/ai/inferenceProviders";
import { resolveDictationTranslationInference } from "./dictationTranslationInference";
import { resolvePrompt, appendScreenContextSuffix } from "../config/prompts";
import { resolveDictationToneStyle } from "../config/toneStyle";
import { selectionEditToneSentence } from "../config/prompts/toneStyle";
import { evaluateFinishedRecording, withSalvageWarning } from "./recordingValidation";
import { isEmptyRecording } from "./recordingGuard";
import { startRecordingSpool, takeInterruptedRecordings } from "./recordingSpool";
import {
  analyzeDictionaryPromptFragment,
  dictionaryEchoError,
  matchesDictionaryPrompt,
  stripTrailingDictionaryEcho,
} from "../utils/dictionaryEchoFilter.js";
import { WHISPER_PROMPT_CHARS, trimDictionaryPrompt } from "../utils/dictionaryPromptCap.js";
import { getDictionaryHintWords } from "../utils/snippets";
import { normalizeAgentSelectionContext } from "../utils/agentSelectionContext";
import { getAgentName } from "../utils/agentName";
import { shouldDisplayDictationPreview } from "../utils/transcriptionPreview";
import {
  buildSelectionEditSystemPrompt,
  buildSelectionEditUserPrompt,
  buildLocalSelectionEditSystemPrompt,
  buildLocalSelectionEditUserPrompt,
  extractLocalSelectionEditReplacement,
  SELECTION_EDIT_RESPONSE_FORMAT,
  extractSelectionEditReplacement,
  getSelectionCaptureDisposition,
  isSelectionQuestionResponse,
} from "./selectionEditing";

const REASONING_CACHE_TTL = 30000; // 30 seconds
// The 25 MB request cap OpenAI-compatible transcription servers commonly enforce.
const WAV_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const RECORDING_TIMESLICE_MS = 250; // flush chunks periodically so short recordings still carry audio frames. See #871.
// Failure detector only: fires when the worklet or audio graph is dead and never flushes.
const PREVIEW_FLUSH_WATCHDOG_MS = 1000;
const neverCancelled = () => false;
const MIN_SPARSE_RECORDING_DURATION_SECONDS = 3;
const MIN_UNIQUE_WORD_GAIN = 2;

// A selection edit that fails leaves its transcript behind; it rides out on the
// error so the failed history entry keeps it. Only those errors carry it: they
// are created per dictation, while others can be one cached rejection shared by
// every dictation. Non-enumerable, so a logged error never writes the text out.
const attachTranscript = (error, transcript, clientTranscriptionId) => {
  if (!error?.selectionEditFatal || error.transcript !== undefined) return;
  const text = typeof transcript === "string" ? transcript.trim() : "";
  if (!text) return;
  Object.defineProperty(error, "transcript", { value: text, configurable: true });
  if (clientTranscriptionId) {
    Object.defineProperty(error, "transcriptClientId", {
      value: clientTranscriptionId,
      configurable: true,
    });
  }
};

const cleanupFailureFromError = (error) => ({
  message: error?.message || String(error),
  ...(error?.messageKey ? { messageKey: error.messageKey } : {}),
  ...(error?.messageParams ? { messageParams: error.messageParams } : {}),
  ...(error?.surface ? { surface: error.surface } : {}),
  ...(error?.settingsTarget ? { settingsTarget: error.settingsTarget } : {}),
  ...(error?.technicalDetails ? { technicalDetails: error.technicalDetails } : {}),
});

const micDeviceKey = (settings) =>
  `${settings.microphoneSelectionMode}|${settings.selectedMicDeviceId}`;

// Shared by the agent route and its text-only retry, which needs the prompt
// without the screen-context suffix.
function dictationAgentPrompt(settings, agentName) {
  return resolvePrompt("dictationAgent", {
    agentName,
    language: settings.preferredLanguage,
    customDictionary: getDictionaryHintWords(settings),
    uiLanguage: settings.uiLanguage,
  });
}

function dictationAgentReachable(settings) {
  return resolveDictationAgentInference(settings).reachable;
}

function translationChainReachable(settings) {
  return resolveDictationTranslationInference(settings).reachable;
}

// Cleanup runs once a local model is picked, or once its self-hosted server is
// set (the server picks its default model when none is named).
function cleanupReachableFor(settings) {
  const cleanup = selectResolvedLLMConfig(settings, "dictationCleanup");
  return (
    !!settings.useCleanupModel &&
    resolveModeReachability({
      mode: cleanup.mode,
      model: cleanup.model,
      isSelfHosted: !!cleanup.remoteUrl?.trim(),
    })
  );
}

function resolveReasoningRoute(
  text,
  settings,
  agentName,
  voiceAgentRequested,
  translationRequested,
  screenContext,
  detectedLanguage
) {
  const wakeWordLanguage = resolveWakeWordLanguage(settings, detectedLanguage, text);
  // Pin cleanup to 0; the local bridge otherwise defaults to 0.7. Zero does not
  // guarantee determinism.
  const cleanupTemperature = 0;
  const cleanupReachable = cleanupReachableFor(settings);
  const agent = resolveDictationAgentInference(settings);
  const translation = resolveDictationTranslationInference(settings);

  const kind = resolveDictationRouteKind({
    cleanupReachable,
    agentReachable: agent.reachable,
    // A translation recording ignores the wake word, so skip the scan.
    agentInvoked:
      !translationRequested &&
      !!agentName &&
      detectAgentName(text, agentName, wakeWordLanguage, settings.snippets),
    voiceAgentRequested,
    translationRequested,
    translationReachable: translation.reachable,
  });
  logger.logReasoning("ROUTE_RESOLVED", {
    kind,
    voiceAgentRequested,
    agentReachable: agent.reachable,
    agentMode: settings.dictationAgentMode,
    agentProvider: agent.displayProvider,
    agentModel: agent.model,
    hasScreenContext: !!screenContext,
  });
  if (translationRequested && kind !== "translation") {
    logger.warn(
      "Translation requested but unreachable, falling back",
      {
        kind,
        useDictationTranslation: settings.useDictationTranslation,
        hasTarget: !!settings.translationTargetLanguage?.trim(),
      },
      "transcription"
    );
  }
  // Shared by ordinary cleanup and the translation chain's cleanup step.
  // A truncated reply must fail rather than replace the dictation with its first part:
  // the cleanup route pastes the raw transcript and the chain translates it, and both
  // raise the cleanup-failed toast (#2091).
  const cleanupConfig = {
    inferenceScope: /** @type {const} */ ("dictationCleanup"),
    disableThinking: settings.cleanupDisableThinking,
    reasoningEffort: settings.cleanupReasoningEffort,
    temperature: cleanupTemperature,
    requireCompleteOutput: true,
  };
  if (kind === "translation") {
    return {
      kind: "translation",
      model: translation.model,
      cleanupReachable,
      cleanupConfig,
      config: {
        ...translation.config,
        systemPrompt: resolvePrompt("translate", {
          agentName,
          targetLanguageLabel: getLanguageLabel(settings.translationTargetLanguage),
          customDictionary: getDictionaryHintWords(settings),
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  if (kind === "agent") {
    const attach = resolveAgentImageTarget({
      hasScreenContext: !!screenContext,
      providerImageWired: scopeAcceptsImages(
        selectResolvedLLMConfig(settings, "dictationAgent"),
        providerSupportsImages
      ),
    });
    logger.logReasoning("AGENT_IMAGE_TARGET", { hasScreenContext: !!screenContext, attach });

    const systemPrompt = dictationAgentPrompt(settings, agentName);

    return {
      kind: "agent",
      cleanupReachable,
      model: agent.model,
      config: {
        ...agent.config,
        systemPrompt: attach
          ? appendScreenContextSuffix(systemPrompt, settings.uiLanguage)
          : systemPrompt,
        ...(attach ? { screenContext, textOnlySystemPrompt: systemPrompt } : {}),
        // Selection edits run on this (dictation) scope, so they need it
        // reachable; standalone commands resolve the same scope again in the
        // panel and report their own configuration problems in-conversation.
        selectionEditReachable: agent.reachable,
        // Detection and stripping must read the transcript identically, so both
        // inputs ride the route rather than being re-read after the await.
        wakeWordLanguage,
        snippets: settings.snippets,
        // The panel re-decides attach/drop for its own request, so carry the
        // raw screenshot past this attach gate for that path.
        ...(screenContext ? { rawScreenContext: screenContext } : {}),
      },
    };
  }
  if (kind === "cleanup") {
    return { kind: "cleanup", cleanupReachable, config: cleanupConfig };
  }
  return { kind: "skip", cleanupReachable };
}

function audioExtensionForMime(mimeType) {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

// Selection-edit copy for a failed reply, looked up by the cause's messageKey,
// then by its code.
const SELECTION_EDIT_FAILURE_COPY = {
  SELECTION_EDIT_INVALID_RESPONSE: "invalidResponse",
  OUTPUT_COMPLETION_UNVERIFIED: "invalidResponse",
  SELECTION_EDIT_EMPTY_RESPONSE: "emptyResponse",
  [EMPTY_OUTPUT_MESSAGE_KEY]: "emptyResponse",
  [TRUNCATED_OUTPUT_MESSAGE_KEY]: "truncatedResponse",
};

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.micCaptureStatus = "inactive";
    this._micWarmedAt = 0;
    this._startInProgress = false;
    this._micOpenReported = false;
    this.preparedMicCapture = new PreparedMicCapture({
      dispose: (prepared) => this._disposePrepared(prepared),
      onActiveChange: () => this._syncMicOpenGate(),
    });
    const micSettings = getSettings();
    this._micHoldSeconds = Number(micSettings.micWarmHoldSeconds) || 0;
    this._micDeviceKey = micDeviceKey(micSettings);
    this.micStreamHold = new MicStreamHold({
      holdSeconds: this._micHoldSeconds,
      onHoldChange: () => this._syncMicOpenGate(),
      isBusy: () =>
        this.isRecording ||
        this.mediaRecorder?.state === "recording" ||
        this.preparedMicCapture.active,
    });

    // Every window owns an AudioManager (dictation and the agent overlay), so
    // the hold has to follow the setting here rather than in one window's hook.
    this._unsubscribeSettings = useSettingsStore.subscribe((state) => {
      const holdSeconds = Number(state.micWarmHoldSeconds) || 0;
      if (holdSeconds !== this._micHoldSeconds) {
        this._micHoldSeconds = holdSeconds;
        this.micStreamHold.setHoldSeconds(holdSeconds);
      }
      const deviceKey = micDeviceKey(state);
      if (deviceKey !== this._micDeviceKey) {
        this._micDeviceKey = deviceKey;
        this.cachedMicDeviceId = null;
        this.rejectedMicDeviceId = null;
        this._micWarmedAt = 0;
        this.cancelPreparedMicCapture();
        this.micStreamHold.drop();
      }
    });

    // Invalidate the pinned mic device when the OS adds/removes/suspends inputs.
    // Otherwise wake-after-idle keeps requesting a stale deviceId that yields silence.
    this._onDeviceChange = () => {
      this.cachedMicDeviceId = null;
      this._micWarmedAt = 0;
      this.rejectedMicDeviceId = null;
      this.cancelPreparedMicCapture();
      this.micStreamHold.drop();
      // The main process keeps the OS default mic until told it changed, so
      // re-resolve now rather than on the next hotkey press (~2s on Windows).
      window.electronAPI?.getSystemDefaultMicrophone?.({ refresh: true })?.catch(() => {});
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", this._onDeviceChange);
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this.cachedMicDeviceId = null;
    this.rejectedMicDeviceId = null;
    this.workletBlobUrl = null;
    this._activeTranscriptionAbortController = null;
    this._recordingSpool = null;
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.translationApplied = false;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this._shownCleanupSetupKey = null;
    this._processingCancellationGeneration = 0;
    this._activeProcessingPipeline = null;
    this.assistantSelectionContext = null;
    this.screenContextPromise = null;
    this.toneStylePromise = null;
    this.selectionCapturePromise = null;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this._localSpeechGateState = null;
    this._streamingCommitActive = false;
    this._previewFlushResolve = null;
    this._batchSegments = [];
    this._batchPcmTap = null;
    this._rotatingBatchRecorder = null;
    this._rotationResolve = null;
    this._stopRequestedDuringMicRecovery = false;
    this._cancelRequestedDuringMicRecovery = false;
    this.micRecovery = new ActiveMicRecoveryController({
      mediaDevices: navigator.mediaDevices,
      acquire: async (reason) => {
        try {
          const constraints = await this.getAudioConstraints(
            false,
            reason === "devicechange" || reason === "devicechange-ended"
          );
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
          logger.debug(
            "Preferred mic unavailable during recovery, falling back to default",
            { error: error.message },
            "audio"
          );
          const fallback = await this.getAudioConstraints(true);
          return navigator.mediaDevices.getUserMedia(fallback);
        }
      },
      onRecovered: (replacement, previous) => this.replaceActiveMic(replacement, previous),
      onStatusChange: (status) => this.setMicCaptureStatus(status),
    });
  }

  // A recording's chunks are spooled until its result is saved, so a hung or
  // crashed app can hand the audio back on the next launch (#2073). Recovered
  // audio lands in history, so spool none the user wouldn't keep.
  _startRecordingSpool() {
    const { dataRetentionEnabled, audioRetentionDays } = getSettings();
    if (!dataRetentionEnabled || audioRetentionDays <= 0) return null;
    return startRecordingSpool(this.translationRequested ? "translation" : null);
  }

  _takeRecordingSpool() {
    const spool = this._recordingSpool;
    this._recordingSpool = null;
    return spool;
  }

  getWorkletBlobUrl() {
    if (this.workletBlobUrl) return this.workletBlobUrl;
    const code = `
const BUFFER_SIZE = 800;
class PCMStreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this.port.postMessage("flushed");
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-streaming-processor", PCMStreamingProcessor);
`;
    this.workletBlobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return this.workletBlobUrl;
  }

  getCustomDictionaryPrompt() {
    const words = getDictionaryHintWords(getSettings());
    return words.length > 0 ? words.join(", ") : null;
  }

  // Script conversion targets whatever the user ends up pasting: the translation
  // target when translating, otherwise the dictation language. Using the STT
  // language here would force zh-TW source audio back to Traditional even when
  // the user asked to translate into Simplified.
  //
  // Only a completed translate step actually moves text into the target language.
  // When translation is unreachable, skipped or fails, the source transcript is
  // what gets pasted, so it must be scripted as the STT language — otherwise a
  // failed ja → zh-CN run would run Japanese through OpenCC (会議の資料 → 会议の数据).
  getEffectiveOutputLanguage(settings) {
    if (this.translationRequested && this.translationApplied) {
      return settings.translationTargetLanguage || "auto";
    }
    return this.getEffectiveSttLanguage(settings);
  }

  // Whisper only accepts language "zh"; script (简体/繁體) is applied here. See #975.
  // No transcript exists yet, so only an explicit zh-CN/zh-TW may bias the prompt.
  getWhisperPrompt(settings = getSettings(), dictionaryPrompt = this.getCustomDictionaryPrompt()) {
    return mergeWhisperPrompt(
      dictionaryPrompt,
      resolveChineseScriptTarget(
        this.getEffectiveSttLanguage(settings),
        settings.chineseScriptPreference
      )
    );
  }

  // Cleanup runs before the translate step, so it still works in the STT language.
  getCleanupLanguage(settings) {
    return resolveCleanupLanguage(this.getEffectiveSttLanguage(settings));
  }

  finalizeChineseScript(text, settings = getSettings()) {
    // A selection edit has already applied its explicit language instruction.
    // A dictation-wide script preference must not rewrite that document again.
    if (this.pendingSelectionEdit) return text;
    return applyChineseScript(
      text,
      resolveChineseScriptTarget(
        this.getEffectiveOutputLanguage(settings),
        settings.chineseScriptPreference,
        text
      )
    );
  }

  // Check the dictionary on its own as well as the full prompt: the echo filter needs
  // 70% of the prompt's words to appear, and a Chinese script bias counts as one more
  // word, which alone pushes a one- or two-term dictionary under the threshold.
  isDictionaryEcho(text) {
    return (
      matchesDictionaryPrompt(text, this.getCustomDictionaryPrompt()) ||
      matchesDictionaryPrompt(text, this.getWhisperPrompt())
    );
  }

  // Drops a hint list the model recited after the speech (#2581). Pass the
  // prompt the request actually carried: a capped prompt can only echo itself.
  // Snippet triggers beside the dictionary never start or count toward a recital.
  stripTrailingDictionaryEcho(text, sentPrompt) {
    const stripped = stripTrailingDictionaryEcho(text, sentPrompt, this.getCustomDictionaryArray());
    if (stripped !== text) {
      logger.debug(
        "Stripped trailing dictionary echo",
        { originalLength: text.length, strippedLength: stripped.length },
        "transcription"
      );
    }
    return stripped;
  }

  setCallbacks({
    onStateChange,
    onError,
    // Optional: the agent overlay has no dictation toast surface.
    onNoAudio = undefined,
    onTranscriptionComplete,
    onTranslationFallback,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onNoAudio = onNoAudio;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onTranslationFallback = onTranslationFallback;
  }

  // Fail-open: translation degraded/failed but raw text is still pasted. Surface why.
  notifyTranslationFallback(reason) {
    this.onTranslationFallback?.({ reason });
  }

  setMicCaptureStatus(status) {
    if (this.micCaptureStatus === status) return;
    this.micCaptureStatus = status;
    this.onStateChange?.({
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      micCaptureStatus: status,
    });
  }

  async beginMicRecovery(stream) {
    // A stop/cancel can land during the awaits between recorder start and this
    // call; never arm recovery for a recording that already ended.
    if (!this.isRecording) return;
    await this.micRecovery.start(stream, {
      followDefault: followsSystemDefaultMic(getSettings()),
    });
  }

  async replaceActiveMic(replacement, previous) {
    if (!this.isRecording) throw new Error("Recording is no longer active");
    await this.replaceBatchMic(replacement, previous);
  }

  async mergeRecordedSegments(segments) {
    // Header-only segments carry no audio frames and crash FFmpeg's concat (#871).
    const usable = segments.filter((segment) => segment && !isEmptyRecording(segment.size));
    if (usable.length === 0) return null;
    if (usable.length === 1) return usable[0];
    const payload = await Promise.all(
      usable.map(async (segment) => ({
        buffer: await segment.arrayBuffer(),
        mimeType: segment.type || "audio/webm",
      }))
    );
    const result = await window.electronAPI.mergeAudioSegments(payload);
    if (!result?.success) throw new Error(result?.error || "Failed to merge audio segments");
    return new Blob([result.buffer], { type: result.mimeType });
  }

  getLargestRecordedSegment(segments) {
    return segments
      .filter((segment) => segment && !isEmptyRecording(segment.size))
      .reduce(
        (largest, segment) => (segment.size > (largest?.size || 0) ? segment : largest),
        null
      );
  }

  setVoiceAgentRequested(requested) {
    this.voiceAgentRequested = requested;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this.assistantSelectionContext = null;
    // No recording must ever see a stale capture (e.g. left over from a
    // cancelled voice-agent recording, even after the setting was turned
    // off). A live voice-agent start re-captures right after this call.
    this.screenContextPromise = null;
    this.toneStylePromise = null;
    // Same for a prefetched selection: bounded to one recording, so a read taken
    // in an earlier app can never be edited in place by this command.
    this.selectionCapturePromise = null;
  }

  setAssistantSelectionContext(context) {
    this.assistantSelectionContext = normalizeAgentSelectionContext(context);
    if (this.assistantSelectionContext) this.selectionCapturePromise = null;
  }

  consumeAssistantSelectionContext() {
    const context = this.assistantSelectionContext;
    this.assistantSelectionContext = null;
    return context;
  }

  setTranslationRequested(requested) {
    this.translationRequested = requested;
    this.translationApplied = false;
  }

  // In translation mode the STT hint is the configured source language, not
  // the UI-wide preferred language; "auto" keeps whisper auto-detection.
  getEffectiveSttLanguage(settings) {
    if (this.translationRequested) {
      return settings.translationSourceLanguage || "auto";
    }
    return settings.preferredLanguage;
  }

  // Kicked off at voice-agent recording start (so the screenshot reflects the
  // invocation moment) and consumed after transcription by the reasoning route.
  beginScreenContextCapture() {
    this.screenContextPromise = window.electronAPI?.captureScreenContext?.() ?? null;
  }

  // Kicked off at voice-agent recording start, alongside the screenshot, so the
  // read resolves while the user is still speaking. The editable-caret probe
  // only matters when auto-paste could deliver to that caret, so the flag
  // spares the main process a binary spawn otherwise.
  beginSelectionCapture() {
    this.selectionCapturePromise =
      window.electronAPI?.captureSelectedText?.({
        probeEditable: Boolean(getSettings().autoPasteEnabled),
      }) ?? null;
    // Marks the stored promise handled without consuming it: a failure nobody is
    // awaiting yet must not surface as an unhandled rejection, and the awaiting
    // caller must still see the original error.
    this.selectionCapturePromise?.catch(() => {});
  }

  consumeSelectionCapture() {
    const pending = this.selectionCapturePromise;
    this.selectionCapturePromise = null;
    return (
      pending ??
      window.electronAPI?.captureSelectedText?.({
        probeEditable: Boolean(getSettings().autoPasteEnabled),
      })
    );
  }

  async consumeScreenContext() {
    const pending = this.screenContextPromise;
    this.screenContextPromise = null;
    if (!pending) return null;
    try {
      // Capture resolves in well under a second; the race only protects the
      // paste path if the IPC ever hangs.
      const image = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!image) logger.logReasoning("SCREEN_CONTEXT_UNAVAILABLE", {});
      return image;
    } catch {
      return null;
    }
  }

  // Kicked off at dictation start while Tone & Style is on, so the target app
  // is classified while the user speaks. Only a dictation that captured its
  // app gets a tone: a retried or re-run transcription has no target.
  beginToneStyleCapture() {
    this.toneStylePromise =
      window.electronAPI?.captureDictationAppCategory?.()?.catch(() => null) ?? null;
  }

  // Consumed by the cleanup route, and by an agent command for an answer
  // typed at the caret or a rewrite of the selection. Translation keeps its
  // source's tone.
  async consumeToneStyle() {
    const pending = this.toneStylePromise;
    this.toneStylePromise = null;
    const settings = getSettings();
    if (!pending || !settings.toneStyleEnabled) return null;
    // Classification lands while the user speaks (a Wayland AT-SPI target takes
    // about a second); the race only guards the paste path if the IPC ever
    // hangs, and an unknown app reads as other.
    const appCategory = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    const toneStyle = resolveDictationToneStyle(settings.toneStyles, appCategory);
    logger.logReasoning("TONE_STYLE", toneStyle);
    return toneStyle;
  }

  // An agent-route failure pastes the spoken command verbatim into the focused
  // app — surface that. Cleanup failures stay quiet; raw text is a fine result.
  _notifyAgentReasoningFailed() {
    this.onError?.({
      code: "AGENT_REASONING_FAILED",
      title: "Agent Unavailable",
      messageKey: "hooks.audioRecording.errorDescriptions.agentReasoningFailed",
    });
  }

  // The command still ran, so this is a downgrade notice rather than a failure.
  _notifyScreenContextSkipped() {
    this.onError?.({
      code: "SCREEN_CONTEXT_SKIPPED",
      title: "Screen Context Skipped",
      messageKey: "hooks.audioRecording.errorDescriptions.screenContextSkipped",
      variant: "default",
    });
  }

  async getAudioConstraints(forceDefaultMic = false, refreshSystemDefault = false) {
    const settings = getSettings();

    // All browser audio processing disabled to avoid OS-level side-effects.
    // AGC off: Chromium's AGC on Windows mutates the system mic volume via WASAPI (#476).
    // Echo cancellation and noise suppression off to avoid latency and speech distortion.
    // Stereo recording required — mono WebM breaks silence detection on Linux/PipeWire (#472).
    const noProcessing = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    };

    if (
      !forceDefaultMic &&
      !refreshSystemDefault &&
      this.cachedMicDeviceId &&
      this.cachedMicDeviceId !== this.rejectedMicDeviceId
    ) {
      return {
        audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing },
      };
    }

    try {
      const resolution = await resolvePreferredMicrophone({
        settings,
        forceSystemDefault: forceDefaultMic,
        refreshSystemDefault: forceDefaultMic || refreshSystemDefault,
      });
      const deviceId = resolution.device?.deviceId;

      if (deviceId && deviceId !== this.rejectedMicDeviceId) {
        if (isCacheableMicrophoneResolution(resolution)) {
          this.cachedMicDeviceId = deviceId;
        }
        logger.debug(
          "Resolved microphone input",
          {
            mode: resolution.mode,
            status: resolution.status,
            label: resolution.device.label,
          },
          "audio"
        );
        return { audio: { deviceId: { exact: deviceId }, ...noProcessing } };
      }

      logger.debug(
        "Microphone selection could not be pinned; using browser fallback",
        { mode: resolution.mode, status: resolution.status },
        "audio"
      );
    } catch (error) {
      logger.debug(
        "Failed to resolve microphone selection; using browser fallback",
        { error: error.message },
        "audio"
      );
    }

    return { audio: noProcessing };
  }

  async cacheMicrophoneDeviceId() {
    if (this.cachedMicDeviceId) return; // Already cached

    try {
      const resolution = await resolvePreferredMicrophone({ settings: getSettings() });
      if (isCacheableMicrophoneResolution(resolution)) {
        this.cachedMicDeviceId = resolution.device.deviceId;
        logger.debug(
          "Microphone device ID pre-cached",
          { mode: resolution.mode, status: resolution.status },
          "audio"
        );
      }
    } catch (error) {
      logger.debug("Failed to pre-cache microphone device ID", { error: error.message }, "audio");
    }
  }

  // Open the mic the moment a dictation is likely (push-to-talk key-down,
  // toggle press) and hand the same stream — plus everything its pre-roll
  // recorder already captured — to the real recording. Replaces the one-shot
  // warmupMicDriver (#845): a raced warm-up never resolved before the
  // recording's own open, so it only ever added a concurrent double open.
  async prepareMicCapture() {
    // A start already awaiting the mic open leaves isRecording false for as long
    // as that open takes, so without this guard a second prepare would open the
    // device again and buffer a pre-roll no recording ever answers.
    if (
      this._startInProgress ||
      this.isRecording ||
      this.isProcessing ||
      this.mediaRecorder?.state === "recording"
    ) {
      return null;
    }
    try {
      const prepared = await this.preparedMicCapture.prepare(async () => {
        // Built before the mic opens so its graph is rendering by the time the
        // pre-roll recorder starts; a tap attached later misses the first frames.
        const pcmTap = this._startPcmTap();
        try {
          const constraints = await this.getAudioConstraints();
          const stream = await this._acquireCaptureStream(constraints);
          const value = {
            stream,
            constraints,
            recorder: null,
            chunks: [],
            pcmTap: null,
            startedAt: Date.now(),
          };
          this._startPreRollRecorder(value, pcmTap);
          if (!value.pcmTap) pcmTap?.close();
          return value;
        } catch (error) {
          pcmTap?.close();
          throw error;
        }
      });
      if (prepared) {
        logger.debug("Microphone capture prepared", { preRoll: !!prepared.recorder }, "audio");
      }
      return prepared;
    } catch (e) {
      logger.debug("Mic capture preparation failed (non-critical)", { error: e.message }, "audio");
      return null;
    }
  }

  cancelPreparedMicCapture() {
    this.preparedMicCapture.cancel();
  }

  // Tells the main process whether this renderer is holding the mic open outside
  // a recording — an idle hold or a prepared capture. Recordings are gated by
  // setUserRecording instead. Without this the device-global macOS/Linux mic
  // signal reports our own capture as a meeting.
  _syncMicOpenGate() {
    const open = this.micStreamHold.active || this.preparedMicCapture.active;
    if (open === this._micOpenReported) return;
    this._micOpenReported = open;
    window.electronAPI?.micWarmHoldChanged?.(open);
  }

  _disposePrepared(prepared) {
    if (!prepared) return;
    disposePreparedCapture(prepared);
    this._markCaptureStreamReleased();
  }

  // Record from the instant the prepared stream delivers frames. If the hold
  // guard confirms a real dictation these chunks become the recording's opening;
  // a cancel discards them without the audio ever leaving the renderer.
  _startPreRollRecorder(prepared, pcmTap) {
    try {
      const recorder = new MediaRecorder(prepared.stream);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) prepared.chunks.push(event.data);
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      pcmTap?.attach(prepared.stream);
      prepared.recorder = recorder;
      prepared.pcmTap = pcmTap;
    } catch (e) {
      logger.debug("Pre-roll recorder unavailable", { error: e.message }, "audio");
    }
  }

  // Offline local engines decode a renderer-captured 16 kHz WAV as-is, so the
  // batch recorder gets a PCM shadow (PcmTap). Online models commit their own
  // stream and every cloud lane wants the smaller WebM, so those get none.
  _startPcmTap() {
    const { useLocalWhisper, localTranscriptionProvider, parakeetModel } = getSettings();
    const offlineLocal =
      useLocalWhisper &&
      !(localTranscriptionProvider === "nvidia" && isOnlineParakeetModel(parakeetModel));
    if (!offlineLocal) return null;
    try {
      return new PcmTap(this.getWorkletBlobUrl());
    } catch (e) {
      logger.debug("PCM tap unavailable", { error: e.message }, "audio");
      return null;
    }
  }

  _closeBatchPcmTap() {
    this._batchPcmTap?.close();
    this._batchPcmTap = null;
  }

  _constraintsKey(constraints) {
    return JSON.stringify(constraints?.audio ?? constraints ?? {});
  }

  _stampMicWarm() {
    this._micWarmedAt = Date.now();
  }

  // Every capture-stream release funnels through here: the driver was
  // demonstrably open, so stamp warmth (a free warm window for the next open,
  // replacing #1284's post-transcription re-warm and its extra device open)
  // and restart the idle-hold countdown.
  _markCaptureStreamReleased() {
    this._stampMicWarm();
    this.micStreamHold.touch();
  }

  async _acquireCaptureStream(constraints) {
    const key = this._constraintsKey(constraints);
    const held = this.micStreamHold.acquireClone(key);
    if (held) {
      this._stampMicWarm();
      return held;
    }
    const stream = await this.acquireHealthyMicStream(
      await navigator.mediaDevices.getUserMedia(constraints),
      constraints
    );
    this._stampMicWarm();
    return this.micStreamHold.adoptAndClone(stream, key);
  }

  // TTL-gated warm-up used only by the streaming-connection warm-up. The
  // recording paths never warm-then-discard — they open once via
  // prepareMicCapture and keep the stream. A stream resolving past the deadline
  // still stamps warmth: the driver did come up, which is exactly what the
  // slowest machines need recorded (#845).
  async _warmMicDriverIfCold(logCategory) {
    // A held master already has the driver up; opening a second device to prove
    // it is the concurrent double open this replaced.
    if (this.micStreamHold.active) {
      this._stampMicWarm();
      return;
    }
    if (isMicWarm(this._micWarmedAt, Date.now())) return;
    try {
      const constraints = await this.getAudioConstraints();
      const streamPromise = navigator.mediaDevices.getUserMedia(constraints);
      streamPromise
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
          this._stampMicWarm();
        })
        .catch(() => {});
      let timer = null;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("mic warmup timed out")),
          WARMUP_ACQUIRE_TIMEOUT_MS
        );
      });
      try {
        await Promise.race([streamPromise, deadline]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      logger.debug("Microphone driver pre-warmed", {}, logCategory);
    } catch (e) {
      logger.debug("Mic driver warmup failed (non-critical)", { error: e.message }, logCategory);
    }
  }

  // Recovers a dead/muted capture: retries the same device, then hops to the OS default,
  // remembering a silent pinned device for the session. Throws MicUnusableError when no
  // input delivers audio. See #1152.
  async acquireHealthyMicStream(rawStream, constraints) {
    const pinnedMicDeviceId = constraints.audio?.deviceId?.exact ?? null;
    let fallbackMicUnusable = false;
    // Keep verifying after a rejection too, otherwise a muted default records silence unnoticed.
    const verifyMic = pinnedMicDeviceId !== null || this.rejectedMicDeviceId !== null;
    const stream = await reacquireIfDead(
      rawStream,
      () => {
        this.cachedMicDeviceId = null;
        return this.getAudioConstraints();
      },
      logger,
      verifyMic
        ? {
            getConstraints: () => this.getAudioConstraints(true),
            onDeviceRejected: () => {
              if (pinnedMicDeviceId) this.rejectedMicDeviceId = pinnedMicDeviceId;
            },
            onFallbackUnusable: () => {
              fallbackMicUnusable = true;
            },
          }
        : null
    );

    if (fallbackMicUnusable) {
      stream.getTracks().forEach((track) => track.stop());
      const micError = new Error("No microphone is delivering audio");
      micError.name = "MicUnusableError";
      throw micError;
    }

    return stream;
  }

  async startRecording(forceDefaultMic = false) {
    let prepared = null;
    let preparedAdopted = false;
    let freshTap = null;
    this._startInProgress = true;
    try {
      if (this.isRecording || this.isProcessing || this.mediaRecorder?.state === "recording") {
        return false;
      }

      const startRequestedAt = performance.now();
      prepared = forceDefaultMic ? null : await this.preparedMicCapture.take();
      const constraints =
        prepared?.constraints ?? (await this.getAudioConstraints(forceDefaultMic));
      // Without a prepared capture the tap starts here, before the mic opens.
      freshTap = prepared ? null : this._startPcmTap();
      const micStream = prepared?.stream ?? (await this._acquireCaptureStream(constraints));
      const micReadyAt = performance.now();

      const audioTrack = micStream.getAudioTracks()[0];

      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      try {
        this._silenceCtx = new AudioContext();
        if (this._silenceCtx.state === "suspended") {
          // Not awaited — resume() can hang when the output device is wedged.
          this._silenceCtx.resume().catch(() => {});
        }
        this._silenceAnalyser = this._silenceCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        this._silenceSource = this._silenceCtx.createMediaStreamSource(micStream);
        this._silenceSource.connect(this._silenceAnalyser);
        this._localSpeechGateState = createLocalSpeechGateState();
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          // A stalled context reads flat silence; recording no windows fails the gate open.
          if (this._silenceCtx?.state !== "running") return;
          this._silenceAnalyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          recordLocalSpeechWindow(this._localSpeechGateState, rms, peak);
        }, 100);
      } catch (e) {
        logger.warn("Audio level gate setup failed, skipping", { error: e.message }, "audio");
        this._localSpeechGateState = null;
      }

      this.audioChunks = [];
      this._batchSegments = [];
      this._closeBatchPcmTap();
      this._stopRequestedDuringMicRecovery = false;
      this._cancelRequestedDuringMicRecovery = false;
      this._receivedAudioData = false;
      const preRollUsable =
        prepared?.recorder?.state === "recording" &&
        Date.now() - prepared.startedAt <= PRE_ROLL_MAX_AGE_MS;
      if (!preRollUsable) discardPreRoll(prepared);
      const preRoll = preRollUsable
        ? { recorder: prepared.recorder, chunks: prepared.chunks }
        : null;
      // Pre-roll audio is part of the recording, so the reported duration
      // starts when the prepared stream started — but only when its recorder
      // was adopted; a prepared stream without pre-roll contributes no audio
      // before this point, and back-dating would inflate durationSeconds.
      this.recordingStartTime = preRoll ? prepared.startedAt : Date.now();
      // The tap shadows the recorder from its first frame: the pre-roll's own,
      // or the one built before the mic opened. A tap started now would miss
      // the opening, so an unusable pre-roll leaves the WebM path in charge.
      this._batchPcmTap = preRoll ? prepared.pcmTap : freshTap;
      this._recordingSpool = this._startRecordingSpool();
      this.createBatchRecorder(micStream, preRoll);
      freshTap?.attach(micStream);
      preparedAdopted = true;
      this.isRecording = true;
      this.onStateChange?.({
        isRecording: true,
        isProcessing: false,
        micCaptureStatus: "active",
      });
      logger.info(
        "Recording start timing",
        {
          micReadyMs: Math.round(micReadyAt - startRequestedAt),
          totalMs: Math.round(performance.now() - startRequestedAt),
          usedPreparedCapture: !!prepared,
          preparedAgeMs: prepared?.startedAt ? Date.now() - prepared.startedAt : 0,
        },
        "audio"
      );

      const {
        showTranscriptionPreview,
        useLocalWhisper,
        localTranscriptionProvider,
        whisperModel,
        parakeetModel,
        cohereModel,
      } = getSettings();
      const isNvidia = localTranscriptionProvider === "nvidia";
      // Online models stream+commit during capture, so PCM runs even with preview off.
      const streamingCommit = useLocalWhisper && isNvidia && isOnlineParakeetModel(parakeetModel);
      this._streamingCommitActive = false;
      if (useLocalWhisper && (showTranscriptionPreview || streamingCommit)) {
        try {
          this._previewAudioContext = new AudioContext({ sampleRate: 16000 });
          this._previewSource = this._previewAudioContext.createMediaStreamSource(micStream);
          await this._previewAudioContext.audioWorklet.addModule(this.getWorkletBlobUrl());

          this._previewProcessor = new AudioWorkletNode(
            this._previewAudioContext,
            "pcm-streaming-processor"
          );
          this._previewProcessor.port.onmessage = (event) => {
            if (event.data === "flushed") {
              this._previewFlushResolve?.();
              return;
            }
            window.electronAPI?.sendDictationPreviewAudio?.(event.data);
          };
          this._previewSource.connect(this._previewProcessor);

          const model = isNvidia
            ? parakeetModel
            : localTranscriptionProvider === "cohere"
              ? cohereModel
              : whisperModel;
          const language = getBaseLanguageCode(getSettings().preferredLanguage);
          window.electronAPI?.startDictationPreview?.({
            provider: localTranscriptionProvider,
            model,
            language,
            display: shouldDisplayDictationPreview(
              showTranscriptionPreview,
              this.voiceAgentRequested
            ),
          });
          this._streamingCommitActive = streamingCommit;
        } catch (e) {
          logger.warn("Preview worklet setup failed", { error: e.message }, "audio");
        }
      }

      await this.beginMicRecovery(micStream);

      return true;
    } catch (error) {
      // A prepared value the recording never adopted still owns a live stream
      // (and possibly a pre-roll recorder); release it before any retry.
      freshTap?.close();
      if (prepared && !preparedAdopted) this._disposePrepared(prepared);
      if (isStaleDeviceError(error) && !forceDefaultMic) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn("Pinned microphone unavailable, retrying on default mic", {}, "audio");
        this.cachedMicDeviceId = null;
        return this.startRecording(true);
      }

      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorTitle = "No Microphone Found";
        errorDescription = "No microphone was detected. Please connect a microphone and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    } finally {
      this._startInProgress = false;
    }
  }

  createBatchRecorder(micStream, adoption = null) {
    // Adopting the pre-roll recorder keeps every chunk captured since key-down:
    // rebinding the handlers below transfers ownership with no gap and no
    // re-encode, and the seeded chunks become the recording's opening.
    const recorder = adoption?.recorder ?? new MediaRecorder(micStream);
    const segmentChunks = adoption ? [...adoption.chunks] : [];
    if (segmentChunks.length > 0) {
      this._receivedAudioData = true;
      // The speech-gate analyser only attaches at recording start, so it never
      // measured these frames. Fail the gate open rather than let it discard a
      // short utterance spoken entirely in pre-roll (#845).
      this._localSpeechGateState = null;
    }
    this.mediaRecorder = recorder;
    this.audioChunks = segmentChunks;
    this.recordingMimeType = recorder.mimeType || "audio/webm";
    // Bound to this recorder: its last chunk lands after a cancel, when the
    // manager may already belong to the next recording.
    const spoolChunk = this._recordingSpool?.addSegment(this.recordingMimeType);
    segmentChunks.forEach((chunk) => spoolChunk?.(chunk));

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this._receivedAudioData = true;
        segmentChunks.push(event.data);
        spoolChunk?.(event.data);
      }
    };

    recorder.onstop = async () => {
      const segment = new Blob(segmentChunks, { type: recorder.mimeType || "audio/webm" });
      segmentChunks.length = 0;
      const rotating = this._rotatingBatchRecorder === recorder;
      // The recorder also stops on its own when its mic track dies (the stream
      // goes inactive). While recovery is armed, treat that like a rotation:
      // bank the segment and keep the recording alive for the replacement mic.
      if (rotating || this.micRecovery.started) {
        if (segment.size > 0) this._batchSegments.push(segment);
        micStream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
        if (rotating) {
          this._rotatingBatchRecorder = null;
          this._rotationResolve?.();
          this._rotationResolve = null;
        } else {
          void this.micRecovery.recover("recorder-stopped");
        }
        return;
      }

      micStream.getTracks().forEach((track) => track.stop());
      this._markCaptureStreamReleased();
      await this.finalizeBatchRecording(segment);
    };

    if (!adoption) recorder.start(RECORDING_TIMESLICE_MS);
    return recorder;
  }

  async finalizeBatchRecording(finalSegment) {
    // Taken now, so a cancelled pipeline that settles late can't end the next
    // recording's spool.
    const spool = this._takeRecordingSpool();
    try {
      await this._finalizeBatchRecording(finalSegment);
    } finally {
      spool?.finish();
    }
  }

  async _finalizeBatchRecording(finalSegment) {
    const processingPipeline = this._startProcessingPipeline();
    const wasCancelled = () => this._shouldAbandonProcessingPipeline(processingPipeline);
    this.micRecovery.stop();
    this.teardownSpeechGate();
    const previewStopPromise = this.cleanupPreview({
      showCleanup: this.shouldShowPreviewCleanupState(),
    });
    const rawWavPromise = this._batchPcmTap?.stop();
    this._batchPcmTap = null;
    this.isRecording = false;
    this.isProcessing = true;
    this.onStateChange?.({
      isRecording: false,
      isProcessing: true,
      micCaptureStatus: "inactive",
    });

    const segments = finalSegment ? [...this._batchSegments, finalSegment] : this._batchSegments;
    this._batchSegments = [];
    const segmentsCount = segments.filter((segment) => segment?.size > 0).length;
    let audioBlob = null;
    let salvagedRecording = false;
    try {
      audioBlob = await this.mergeRecordedSegments(segments);
    } catch (error) {
      if (wasCancelled()) {
        this._settleProcessingPipeline(processingPipeline);
        return;
      }
      logger.error("Failed to assemble recovered recording", { error: error.message }, "audio");
      // Salvage the largest segment rather than dropping the whole recording.
      audioBlob = this.getLargestRecordedSegment(segments);
      salvagedRecording = !!audioBlob;
    }
    if (wasCancelled()) {
      this._settleProcessingPipeline(processingPipeline);
      return;
    }
    audioBlob = audioBlob || new Blob([], { type: this.recordingMimeType || "audio/webm" });
    this.lastAudioBlob = audioBlob;

    logger.info(
      "Recording stopped",
      {
        blobSize: audioBlob.size,
        blobType: audioBlob.type,
        segmentsCount,
      },
      "audio"
    );

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;
    const analyticsOccurredAt = new Date(this.recordingStartTime || Date.now()).toISOString();
    this.recordingStartTime = null;
    const recordingCheck = evaluateFinishedRecording({
      blobSize: audioBlob.size,
      receivedAudioData: this._receivedAudioData,
    });
    if (!recordingCheck.usable) {
      logger.info(
        "Dropping degenerate recording before transcription",
        {
          blobSize: audioBlob.size,
          reason: recordingCheck.reason,
          receivedAudioData: this._receivedAudioData,
        },
        "audio"
      );
      if (!this._settleProcessingPipeline(processingPipeline)) return;
      this._localSpeechGateState = null;
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }
    // Non-commit sessions stop concurrently with the decode below.
    const previewStop = this._streamingCommitActive ? await previewStopPromise : null;
    if (wasCancelled()) {
      this._settleProcessingPipeline(processingPipeline);
      return;
    }
    this._streamingCommitActive = false;
    const rawWav = await rawWavPromise;

    await this.processAudio(
      audioBlob,
      {
        durationSeconds,
        analyticsOccurredAt,
        ...(salvagedRecording ? { salvagedRecording: true } : {}),
        ...(previewStop?.streamed ? { streamedText: previewStop.text } : {}),
        ...(rawWav ? { rawWav } : {}),
      },
      processingPipeline
    );
    await processingPipeline.resultHandled;
  }

  async replaceBatchMic(replacement) {
    try {
      const recorder = this.mediaRecorder;
      if (!recorder) throw new Error("Batch recorder is no longer active");
      // An auto-stopped recorder (mic track died) already banked its segment in
      // onstop; only a live recorder needs the explicit rotation handshake.
      if (recorder.state === "recording") {
        await new Promise((resolve) => {
          this._rotatingBatchRecorder = recorder;
          this._rotationResolve = resolve;
          recorder.stop();
        });
      }
      if (!this.isRecording) throw new Error("Recording stopped during microphone recovery");

      this._silenceSource?.disconnect();
      if (this._silenceCtx && this._silenceAnalyser) {
        this._silenceSource = this._silenceCtx.createMediaStreamSource(replacement);
        this._silenceSource.connect(this._silenceAnalyser);
      }
      this._previewSource?.disconnect();
      if (this._previewAudioContext && this._previewProcessor) {
        this._previewSource = this._previewAudioContext.createMediaStreamSource(replacement);
        this._previewSource.connect(this._previewProcessor);
      }
      this._batchPcmTap?.attach(replacement);
      this.createBatchRecorder(replacement);
    } finally {
      // Honor a stop/cancel that arrived mid-rotation even when the swap failed —
      // dropping it would leave an unstoppable recording (isRecording stuck true).
      const cancelRequested = this._cancelRequestedDuringMicRecovery;
      const stopRequested = this._stopRequestedDuringMicRecovery;
      this._cancelRequestedDuringMicRecovery = false;
      this._stopRequestedDuringMicRecovery = false;
      if (cancelRequested) this.cancelRecording();
      else if (stopRequested) this.stopRecording();
    }
  }

  stopRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._stopRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
      return true;
    }
    if (this.isRecording) {
      // The mic died mid-recovery, so no live recorder exists; finalize what
      // was captured instead of leaving the recording unstoppable.
      void this.finalizeBatchRecording(null);
      return true;
    }
    return false;
  }

  teardownSpeechGate() {
    if (this._silenceInterval) {
      clearInterval(this._silenceInterval);
      this._silenceInterval = null;
    }
    this._silenceCtx?.close().catch(() => {});
    this._silenceCtx = null;
    this._silenceAnalyser = null;
    this._silenceSource = null;
    this._levelData = null;
  }

  // Live input level (RMS 0..~1) for the waveform, read from the speech-gate
  // analyser. Null (waveform rests) when it isn't live.
  getRecordingAudioLevel() {
    const pair = this._silenceAnalyser
      ? { ctx: this._silenceCtx, analyser: this._silenceAnalyser }
      : null;
    if (!pair?.ctx) return null;
    if (pair.ctx.state === "suspended") {
      // A suspended context reads flat silence — nudge it awake (not awaited;
      // resume() can hang when the output device is wedged).
      pair.ctx.resume().catch(() => {});
      return null;
    }
    if (pair.ctx.state !== "running") return null;
    const analyser = pair.analyser;
    if (!this._levelData || this._levelData.length !== analyser.fftSize) {
      this._levelData = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(this._levelData);
    let sum = 0;
    for (let i = 0; i < this._levelData.length; i++) {
      const v = (this._levelData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this._levelData.length);
  }

  cancelRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._cancelRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      const recorder = this.mediaRecorder;
      const discarded = this.takeDiscardedBatchSnapshot();
      this.mediaRecorder.onstop = () => {
        recorder.stream?.getTracks().forEach((track) => track.stop());
        this.persistDiscardedBatchRecording(discarded);
      };

      // Detach from manager state before recorder.stop(): its final
      // dataavailable/onstop land async and must not block or observe the
      // next recording.
      this.resetDiscardedBatchRecordingState();

      recorder.stop();

      if (recorder.stream) {
        recorder.stream.getTracks().forEach((track) => track.stop());
        this._markCaptureStreamReleased();
      }

      return true;
    }
    if (this.isRecording) {
      // The mic died mid-recovery, so no live recorder exists; discard what was
      // captured instead of leaving the recording uncancelable.
      this.discardBatchRecording();
      return true;
    }
    return false;
  }

  discardBatchRecording() {
    const discarded = this.takeDiscardedBatchSnapshot();
    this.resetDiscardedBatchRecordingState();
    this.persistDiscardedBatchRecording(discarded);
  }

  takeDiscardedBatchSnapshot() {
    return {
      durationSeconds: this.recordingStartTime
        ? (Date.now() - this.recordingStartTime) / 1000
        : null,
      analyticsOccurredAt: new Date(this.recordingStartTime || Date.now()).toISOString(),
      chunks: this.audioChunks,
      segments: this._batchSegments,
      mimeType: this.recordingMimeType,
    };
  }

  resetDiscardedBatchRecordingState() {
    this._takeRecordingSpool()?.finish();
    this.teardownSpeechGate();
    this._localSpeechGateState = null;

    this.cleanupPreview({ dismiss: true });
    this._closeBatchPcmTap();
    this.isRecording = false;
    this.isProcessing = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this._batchSegments = [];
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: false });
  }

  persistDiscardedBatchRecording({
    durationSeconds,
    analyticsOccurredAt,
    chunks,
    segments,
    mimeType,
  }) {
    // This must run after MediaRecorder's final dataavailable event, so decide
    // whether to retain the discarded audio from the snapshot rather than live
    // manager state (which may already belong to a new recording).
    const shouldSave =
      shouldSaveDiscardedRecording(getSettings(), durationSeconds) &&
      (chunks.length > 0 || segments.length > 0);
    if (shouldSave) {
      // Assemble and save in the background — the merge crosses IPC into FFmpeg
      // and must not delay the recorder becoming available again.
      void (async () => {
        try {
          const current = new Blob(chunks, { type: mimeType });
          const blob = await this.mergeRecordedSegments([...segments, current]);
          if (blob)
            await this.saveDiscardedTranscription(blob, durationSeconds, analyticsOccurredAt);
        } catch (error) {
          const fallback = this.getLargestRecordedSegment([
            ...segments,
            new Blob(chunks, { type: mimeType }),
          ]);
          if (fallback) {
            try {
              await this.saveDiscardedTranscription(fallback, durationSeconds, analyticsOccurredAt);
            } catch (fallbackError) {
              logger.warn(
                "Failed to save discarded recording fallback",
                { error: fallbackError.message },
                "audio"
              );
            }
            return;
          }
          logger.warn("Failed to save discarded recording", { error: error.message }, "audio");
        }
      })();
    }
  }

  _startProcessingPipeline() {
    const pipeline = {
      cancellationGeneration: this._processingCancellationGeneration ?? 0,
    };
    this._activeProcessingPipeline = pipeline;
    return pipeline;
  }

  _shouldAbandonProcessingPipeline(pipeline) {
    return (
      pipeline.cancellationGeneration !== (this._processingCancellationGeneration ?? 0) ||
      this._activeProcessingPipeline !== pipeline
    );
  }

  _settleProcessingPipeline(pipeline) {
    if (this._activeProcessingPipeline !== pipeline) return false;
    this._activeProcessingPipeline = null;
    if (this.isProcessing) {
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
    }
    return true;
  }

  _abortInFlightProcessing() {
    ReasoningService.cancelAllRequests();
    this._activeTranscriptionAbortController?.abort();
    this._activeTranscriptionAbortController = null;
    this.pendingSelectionEdit = null;
    this.pendingAssistantConversation = null;
    this.pendingCleanupFailure = null;
    this.assistantSelectionContext = null;
    this.screenContextPromise = null;
    this.selectionCapturePromise = null;
  }

  cancelProcessing() {
    if (this.isProcessing) {
      this._processingCancellationGeneration = (this._processingCancellationGeneration ?? 0) + 1;
      this._abortInFlightProcessing();
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      // finalizeBatchRecording's earlier cleanupPreview() call (without
      // dismiss:true) already put the live-transcript panel in a "hold"
      // state — meant to keep showing the final/cleanup text, not close it.
      // onError used to be what actually closed the panel on a failure; the
      // processAudio cancel guard means onError never fires for a cancel, so
      // the close has to happen here instead, independent of onError.
      window.electronAPI?.dismissDictationPreview?.();
      return true;
    }
    return false;
  }

  async processAudio(audioBlob, metadata = {}, processingPipeline = null) {
    const pipeline = processingPipeline ?? this._startProcessingPipeline();
    if (processingPipeline && this._activeProcessingPipeline !== processingPipeline) return;
    const wasCancelled = () => this._shouldAbandonProcessingPipeline(pipeline);
    const pipelineStart = performance.now();
    const settings = getSettings();
    let noAudioDetected = false;
    const speechGateDecision = getLocalSpeechGateDecision(this._localSpeechGateState);
    this._localSpeechGateState = null;

    const shouldUseStrongLocalWhisperGate =
      settings.useLocalWhisper && settings.localTranscriptionProvider === "whisper";
    if (
      speechGateDecision.skip &&
      (speechGateDecision.reason === "silence" || shouldUseStrongLocalWhisperGate)
    ) {
      logger.info(
        "Speech gate skipped transcription",
        {
          reason: speechGateDecision.reason,
          useLocalWhisper: settings.useLocalWhisper,
          localProvider: settings.localTranscriptionProvider,
          peakRms: speechGateDecision.peakRms?.toFixed(4),
          peakAmplitude: speechGateDecision.peakAmplitude?.toFixed(4),
          speechWindowCount: speechGateDecision.speechWindowCount,
          maxConsecutiveSpeechWindows: speechGateDecision.maxConsecutiveSpeechWindows,
        },
        "audio"
      );
      if (!this._settleProcessingPipeline(pipeline)) return;
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }

    try {
      const useLocalWhisper = settings.useLocalWhisper;
      const localProvider = settings.localTranscriptionProvider;
      const whisperModel = settings.whisperModel;
      const parakeetModel = settings.parakeetModel || "parakeet-tdt-0.6b-v3";

      logger.debug(
        "Transcription routing",
        { useLocalWhisper, transcriptionMode: settings.transcriptionMode },
        "transcription"
      );

      let result;
      let activeModel;
      if (useLocalWhisper) {
        if (isSherpaLocalProvider(localProvider)) {
          activeModel = localProvider === "cohere" ? settings.cohereModel : parakeetModel;
          result = await this.processWithLocalParakeet(
            audioBlob,
            activeModel,
            metadata,
            wasCancelled
          );
        } else {
          activeModel = whisperModel;
          result = await this.processWithLocalWhisper(
            audioBlob,
            whisperModel,
            metadata,
            wasCancelled
          );
        }
      } else {
        activeModel = resolveSelfHostedTranscriptionModel(settings);
        result = await this.processWithSelfHosted(audioBlob, metadata, wasCancelled);
      }

      if (wasCancelled() || !this.isProcessing) {
        return;
      }

      this.lastAudioMetadata = {
        durationMs: metadata?.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : Math.round(performance.now() - pipelineStart),
        provider: result?.source || (useLocalWhisper ? localProvider : "self-hosted"),
        model: activeModel || null,
      };

      // A salvaged WebM only matters to whoever decoded it; the tap's WAV spans
      // the whole recording.
      result = withSalvageWarning(result, metadata.salvagedRecording && !result?.decodedRawWav);

      result = {
        ...result,
        ...(metadata.analyticsOccurredAt
          ? { analyticsOccurredAt: metadata.analyticsOccurredAt }
          : {}),
        ...this._takePendingResultExtras(),
      };
      if (wasCancelled()) return;
      // Settles once the result is delivered and saved; the recording's spool
      // waits for it, so a main process that hangs on the paste or the save
      // can't take the audio with it.
      pipeline.resultHandled = this.onTranscriptionComplete?.(result);

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      const timingData = {
        mode: useLocalWhisper ? `local-${localProvider}` : "self-hosted",
        model: activeModel,
        audioDurationMs: metadata.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : null,
        reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
        roundTripDurationMs,
        audioSizeBytes: audioBlob.size,
        audioFormat: audioBlob.type,
        outputTextLength: result?.text?.length,
      };

      if (useLocalWhisper) {
        timingData.audioConversionDurationMs = result?.timings?.audioConversionDurationMs ?? null;
      }
      timingData.transcriptionProcessingDurationMs =
        result?.timings?.transcriptionProcessingDurationMs ?? null;

      logger.info("Pipeline timing", timingData, "performance");
    } catch (error) {
      const errorAtMs = Math.round(performance.now() - pipelineStart);

      if (wasCancelled()) {
        // The user cancelled mid-pipeline; the aborted request's rejection is
        // the expected outcome, not a failure to report or persist.
        logger.info("Transcription cancelled by user", { errorAtMs }, "performance");
        return;
      }

      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      const outcome = transcriptionFailureOutcome(error);
      noAudioDetected = outcome.noAudio;
      if (outcome.report) this.onError?.(outcome.report);
      if (outcome.keepAudio && this.lastAudioBlob) {
        pipeline.resultHandled = this.saveFailedTranscription(
          error.message,
          error.code || null,
          metadata,
          { transcript: error.transcript, clientTranscriptionId: error.transcriptClientId }
        );
      }
    } finally {
      const shouldNotifyNoAudio =
        !wasCancelled() && noAudioDetected && this._activeProcessingPipeline === pipeline;
      this._settleProcessingPipeline(pipeline);
      // Every provider reports genuine silence through this one post-processing
      // outcome. The pill can now leave thinking before the error surface takes
      // ownership, instead of receiving an IPC event mid-pipeline.
      if (shouldNotifyNoAudio) this.onNoAudio?.();
    }
  }

  async processWithLocalWhisper(
    audioBlob,
    model = "base",
    metadata = {},
    wasCancelled = neverCancelled
  ) {
    const timings = {};

    try {
      // The PCM tap's WAV skips FFmpeg in the main process; the WebM stays the
      // fallback and is what history and any cloud retry receive.
      const source = metadata.rawWav ?? audioBlob;
      const arrayBuffer = await source.arrayBuffer();
      const language = getBaseLanguageCode(this.getEffectiveSttLanguage(getSettings()));
      const options = { model };
      if (language) {
        options.language = language;
      }

      // Add custom dictionary as initial prompt to help Whisper recognize specific words
      const customDictionaryPrompt = this.getCustomDictionaryPrompt();
      const dictionaryPrompt = this.getWhisperPrompt();
      if (dictionaryPrompt) {
        options.initialPrompt = dictionaryPrompt;
      }

      logger.debug(
        "Local transcription starting",
        {
          audioFormat: source.type,
          audioSizeBytes: source.size,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      let result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Local transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        const strictDictionaryEcho = Boolean(
          dictionaryPrompt &&
          (matchesDictionaryPrompt(result.text, dictionaryPrompt) ||
            matchesDictionaryPrompt(result.text, customDictionaryPrompt))
        );
        const initialFragment = analyzeDictionaryPromptFragment(result.text, dictionaryPrompt);
        const dictionaryPromptFragment = !strictDictionaryEcho && initialFragment.isPromptFragment;
        // A non-repeated fragment can only be replaced by the sparse-recording rule
        // below, so on a short recording the retry would be decoded and then discarded.
        const retryCanBeAdopted =
          strictDictionaryEcho ||
          initialFragment.hasRepeatedWords ||
          (Number.isFinite(metadata.durationSeconds) &&
            metadata.durationSeconds >= MIN_SPARSE_RECORDING_DURATION_SECONDS);

        if ((strictDictionaryEcho || dictionaryPromptFragment) && retryCanBeAdopted) {
          // A prompt-free, VAD-free retry distinguishes real speech from Whisper
          // continuing either the whole dictionary prompt or a short fragment of it.
          const retryStart = performance.now();
          let retry = null;
          try {
            retry = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, {
              model: options.model,
              ...(options.language ? { language: options.language } : {}),
              skipVad: true,
            });
          } catch (retryError) {
            if (strictDictionaryEcho) throw retryError;
            // A heuristic recovery is best-effort; keep the initial text if it fails.
            logger.warn(
              "Dictionary-fragment retry failed; keeping the initial transcript",
              { message: retryError?.message },
              "audio"
            );
          }

          const retryText = retry?.success && typeof retry.text === "string" ? retry.text : "";
          const hasRetryText = Boolean(retryText.trim());
          const retryFragment = analyzeDictionaryPromptFragment(retryText, dictionaryPrompt);
          const retryStrictDictionaryEcho = Boolean(
            hasRetryText &&
            (matchesDictionaryPrompt(retryText, dictionaryPrompt) ||
              matchesDictionaryPrompt(retryText, customDictionaryPrompt))
          );
          // On the strict path a short, dictionary-spelled retry is the recovered
          // dictation (#1454), not a second echo — only another full-prompt echo
          // disqualifies it. The fragment test applies to the heuristic path alone.
          const retryStillPromptLike = strictDictionaryEcho
            ? retryStrictDictionaryEcho
            : retryStrictDictionaryEcho || retryFragment.isPromptFragment;
          const retryAddsUniqueWords =
            retryFragment.uniqueWordCount > initialFragment.uniqueWordCount;
          const repeatedFragmentRecovered =
            initialFragment.hasRepeatedWords && retryAddsUniqueWords;
          // A non-repeated dictionary term or snippet is valid short-form
          // dictation unless a long recording yields substantially more content.
          const sparseRecordingRecovered =
            Number.isFinite(metadata.durationSeconds) &&
            metadata.durationSeconds >= MIN_SPARSE_RECORDING_DURATION_SECONDS &&
            retryFragment.uniqueWordCount >= initialFragment.uniqueWordCount + MIN_UNIQUE_WORD_GAIN;
          const recovered =
            hasRetryText &&
            !retryStillPromptLike &&
            (strictDictionaryEcho || repeatedFragmentRecovered || sparseRecordingRecovered);

          logger.info(
            "Local dictionary-prompt recovery attempt",
            {
              reason: strictDictionaryEcho ? "strict-echo" : "prompt-fragment",
              retryDurationMs: Math.round(performance.now() - retryStart),
              promptLength: dictionaryPrompt.length,
              initialTextLength: result.text.length,
              retryTextLength: retryText.length,
              recovered,
            },
            "audio"
          );

          timings.transcriptionProcessingDurationMs = Math.round(
            performance.now() - transcriptionStart
          );

          if (recovered) {
            result = retry;
          } else if (strictDictionaryEcho) {
            throw dictionaryEchoError();
          }
        }
        const rawText = result.text;
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local", wasCancelled);
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return {
            success: true,
            text: text || result.text,
            rawText,
            source: "local",
            timings,
            ...(metadata.rawWav ? { decodedRawWav: true } : {}),
          };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Local Whisper transcription failed");
      }
    } catch (error) {
      if (error.selectionEditFatal) {
        throw error;
      }
      if (error.message === "No audio detected") {
        throw error;
      }

      throw new Error(`Local Whisper failed: ${error.message}`);
    }
  }

  async processWithLocalParakeet(
    audioBlob,
    model = "parakeet-tdt-0.6b-v3",
    metadata = {},
    wasCancelled = neverCancelled
  ) {
    const timings = {};

    try {
      let result;
      const streamedText =
        typeof metadata.streamedText === "string" ? metadata.streamedText.trim() : null;
      // An empty stream is indistinguishable from silence; let the offline decode settle it.
      if (streamedText) {
        logger.debug("Parakeet using committed streaming transcript", { model }, "performance");
        timings.transcriptionProcessingDurationMs = 0;
        result = { success: true, text: streamedText };
      } else {
        const source = metadata.rawWav ?? audioBlob;
        const arrayBuffer = await source.arrayBuffer();

        logger.debug(
          "Parakeet transcription starting",
          {
            audioFormat: source.type,
            audioSizeBytes: source.size,
            model,
          },
          "performance"
        );

        const transcriptionStart = performance.now();
        result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, {
          model,
          language: getBaseLanguageCode(this.getEffectiveSttLanguage(getSettings())),
        });
        timings.transcriptionProcessingDurationMs = Math.round(
          performance.now() - transcriptionStart
        );

        logger.debug(
          "Parakeet transcription complete",
          {
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            success: result.success,
          },
          "performance"
        );
      }

      if (result.success && result.text) {
        const rawText = result.text;
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local-parakeet", wasCancelled);
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return {
            success: true,
            text: text || result.text,
            rawText,
            source: "local-parakeet",
            timings,
            ...(result.warning ? { warning: result.warning } : {}),
            ...(metadata.rawWav ? { decodedRawWav: true } : {}),
          };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Parakeet transcription failed");
      }
    } catch (error) {
      if (error.selectionEditFatal) {
        throw error;
      }
      if (error.message === "No audio detected") {
        throw error;
      }

      throw new Error(`Parakeet failed: ${error.message}`);
    }
  }

  // The self-hosted server's key is optional: an empty one sends no header.
  async getSelfHostedApiKey() {
    let apiKey = getSettings().customTranscriptionApiKey || "";
    if (!apiKey.trim()) {
      try {
        apiKey = (await window.electronAPI.getCustomTranscriptionKey?.()) || "";
      } catch (err) {
        logger.debug(
          "Failed to get self-hosted transcription key via IPC",
          { error: err?.message },
          "transcription"
        );
      }
    }
    return apiKey.trim() || null;
  }

  async processWithReasoningModel(text, model, agentName, config) {
    logger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      textLength: text.length,
      hasOverrides: !!config,
    });

    const startTime = Date.now();

    try {
      const result = await ReasoningService.processText(text, model, agentName, config);

      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      // A screenshot the model or transport rejects must not cost the user
      // their command — rerun it text-only, swapping in the pre-built prompt
      // that never had the screen-context suffix. Rebuilding from scratch
      // would drop the selection-edit instructions and completion marker.
      // rawScreenContext/selectionEditReachable are routing-only keys (see
      // processAgentCommand) — keep the retry config clean of them too.
      if (config?.screenContext) {
        const {
          screenContext,
          rawScreenContext,
          selectionEditReachable,
          textOnlySystemPrompt,
          ...textOnlyConfig
        } = config;
        const result = await ReasoningService.processText(text, model, agentName, {
          ...textOnlyConfig,
          systemPrompt: textOnlySystemPrompt ?? dictationAgentPrompt(getSettings(), agentName),
        });
        this._notifyScreenContextSkipped();
        return result;
      }

      throw error;
    }
  }

  // Panel-first banking: the command streams into the assistant panel with
  // the chat's tools and memory once transcription completes; nothing types
  // at the cursor. The transcript flows back as the result text so history
  // and previews stay truthful.
  _bankAssistantDirective(transcript, config, options = {}) {
    if (!this.isProcessing) return;
    const { selectedContext, deliverySessionId, deliveryAcceptsMarkdown, deliveryAppCategory } =
      options || {};
    this.pendingAssistantConversation = {
      transcript,
      // resolveReasoningRoute mirrors an attached screenContext into
      // rawScreenContext (same object), so the raw carry is the single source
      // to read — it also survives when this attach gate dropped the image
      // (the panel re-decides for its own request).
      screenContext: config?.rawScreenContext ?? null,
      ...(selectedContext ? { selectedContext } : {}),
      ...(deliverySessionId ? { deliverySessionId, deliveryAcceptsMarkdown } : {}),
      ...(deliveryAppCategory ? { deliveryAppCategory } : {}),
    };
  }

  // Consume the directives banked during reasoning so that exactly one
  // transcription result — batch or streaming — carries them.
  _takePendingResultExtras() {
    const extras = {
      ...(this.pendingAssistantConversation
        ? { assistantConversation: this.pendingAssistantConversation }
        : {}),
      ...(this.pendingSelectionEdit ? { selectionEdit: this.pendingSelectionEdit } : {}),
      ...(this.pendingCleanupFailure ? { cleanupFailure: this.pendingCleanupFailure } : {}),
    };
    this.pendingAssistantConversation = null;
    this.pendingSelectionEdit = null;
    this.pendingCleanupFailure = null;
    return extras;
  }

  // Panel-first commands make no LLM call here — the panel resolves the Voice
  // Assistant scope itself.
  _bankPanelAgentCommand(
    text,
    agentName,
    config,
    {
      selectedContext,
      selectedText,
      deliverySessionId,
      deliveryAcceptsMarkdown,
      deliveryAppCategory,
    } = {}
  ) {
    const settings = getSettings();
    const command = this.voiceAgentRequested
      ? text
      : stripAgentAddress(
          text,
          agentName,
          config?.wakeWordLanguage ?? resolveWakeWordLanguage(settings),
          config?.snippets ?? settings.snippets
        );
    const transcript = selectedText === undefined ? command : `${command}\n\n"${selectedText}"`;
    this._bankAssistantDirective(transcript, config, {
      selectedContext,
      deliverySessionId,
      deliveryAcceptsMarkdown,
      deliveryAppCategory,
    });
    return text;
  }

  async processAgentCommand(text, model, agentName, config, wasCancelled = neverCancelled) {
    if (wasCancelled()) return text;
    const assistantSelectionContext = this.consumeAssistantSelectionContext();
    if (assistantSelectionContext) {
      // An in-panel selection is conversational context, not an editable OS
      // target. Keep it on the existing panel-first route and leave the
      // external selection replacement path completely untouched.
      this.selectionCapturePromise = null;
      return this._bankPanelAgentCommand(text, agentName, config, {
        selectedContext: assistantSelectionContext,
      });
    }

    let capture;
    try {
      capture = await this.consumeSelectionCapture();
    } catch (cause) {
      const error = new Error(
        `Selection edit could not safely read the selection: ${cause.message}`
      );
      error.code = "SELECTION_EDIT_CAPTURE_FAILED";
      error.messageKey = "hooks.audioRecording.selectionEditing.unavailable";
      error.selectionEditFatal = true;
      error.cause = cause;
      throw error;
    }
    if (wasCancelled()) return text;

    const captureDisposition = getSelectionCaptureDisposition(capture);
    const deliverySessionId =
      captureDisposition === "caret" && getSettings().autoPasteEnabled
        ? capture.sessionId
        : undefined;
    const deliveryAcceptsMarkdown = capture?.acceptsMarkdown === true;
    const toneStyle = await this.consumeToneStyle();
    const deliveryAppCategory = deliverySessionId ? toneStyle?.appCategory : undefined;

    if (!config?.selectionEditReachable) {
      // No in-place editor: the panel never types, so only a readable
      // selection is quoted; every other capture sends the plain command.
      return this._bankPanelAgentCommand(text, agentName, config, {
        selectedText:
          captureDisposition === "selection" && typeof capture?.text === "string"
            ? capture.text
            : undefined,
        deliverySessionId,
        deliveryAcceptsMarkdown,
        deliveryAppCategory,
      });
    }

    if (capture?.status === "too_large") {
      // A large selection definitely exists, so running the command as plain
      // agent dictation would paste over it — the one capture failure that
      // must not fall through.
      const error = new Error(
        `Selected text exceeds the ${capture.maxCharacters || 6000} character limit`
      );
      error.code = "SELECTION_EDIT_TOO_LARGE";
      error.messageKey = "hooks.audioRecording.selectionEditing.tooLarge";
      error.selectionEditFatal = true;
      throw error;
    }

    if (captureDisposition === "standalone" || captureDisposition === "caret") {
      return this._bankPanelAgentCommand(text, agentName, config, {
        deliverySessionId,
        deliveryAcceptsMarkdown,
        deliveryAppCategory,
      });
    }

    if (capture?.status !== "selected") {
      // A captured target changing, a synthetic-copy failure, or an unexpected
      // accessibility result is ambiguous: a normal agent paste could overwrite
      // unrelated selected text. Abort instead of falling through.
      const error = new Error("Selection edit could not safely verify the selected text");
      error.code = "SELECTION_EDIT_CAPTURE_FAILED";
      error.messageKey =
        captureDisposition === "changed"
          ? "hooks.audioRecording.selectionEditing.changed"
          : "hooks.audioRecording.selectionEditing.unavailable";
      error.selectionEditFatal = true;
      throw error;
    }

    // These are routing directives for this method, not reasoning options —
    // strip them before the config reaches ReasoningService.
    const { selectionEditReachable, rawScreenContext, wakeWordLanguage, ...reasoningOptions } =
      config ?? {};
    const selectionConfig = {
      ...reasoningOptions,
      maxTokens: Math.max(config?.maxTokens || 0, 8192),
      contextSize: Math.max(config?.contextSize || 0, 16384),
      temperature: config?.temperature ?? 0.2,
      requireCompleteOutput: true,
    };
    const isLocalSelection = config?.provider === "local";
    const toneSentence = toneStyle ? selectionEditToneSentence(toneStyle) : "";
    const withToneSentence = (prompt) =>
      toneSentence ? `${String(prompt ?? "").trim()}\n\n${toneSentence}` : prompt;
    let userPrompt;
    let completionMarker;
    if (isLocalSelection) {
      const settings = getSettings();
      selectionConfig.systemPrompt = buildLocalSelectionEditSystemPrompt({
        customPrompt: (settings.customPrompts.dictationAgent || "").replace(
          /\{\{agentName\}\}/g,
          agentName?.trim() || "Assistant"
        ),
        dictionary: getDictionaryHintWords(settings),
        toneSentence,
      });
      selectionConfig.responseFormat = SELECTION_EDIT_RESPONSE_FORMAT;
      selectionConfig.disableThinking = true;
      const instruction = this.voiceAgentRequested
        ? text
        : stripAgentAddressPreservingFormatting(
            text,
            agentName,
            wakeWordLanguage ?? resolveWakeWordLanguage(settings),
            config?.snippets ?? settings.snippets
          );
      userPrompt = buildLocalSelectionEditUserPrompt(instruction, capture.text);
    } else {
      completionMarker = `__OPENWHISPR_SELECTION_COMPLETE_${crypto.randomUUID()}__`;
      selectionConfig.systemPrompt = buildSelectionEditSystemPrompt(
        withToneSentence(config?.systemPrompt),
        completionMarker
      );
      if (selectionConfig.textOnlySystemPrompt) {
        // The text-only retry prompt must carry the same selection-edit
        // instructions and marker, or a rejected screenshot loses the command.
        selectionConfig.textOnlySystemPrompt = buildSelectionEditSystemPrompt(
          withToneSentence(selectionConfig.textOnlySystemPrompt),
          completionMarker
        );
      }
      userPrompt = buildSelectionEditUserPrompt(text, capture.text);
    }

    try {
      const result = await this.processWithReasoningModel(
        userPrompt,
        model,
        agentName,
        selectionConfig
      );
      if (wasCancelled()) return text;
      if (!isSelectionQuestionResponse(result, completionMarker)) {
        const replacement = isLocalSelection
          ? extractLocalSelectionEditReplacement(result)
          : extractSelectionEditReplacement(result, completionMarker);
        this.pendingSelectionEdit = { sessionId: capture.sessionId };
        return replacement;
      }
    } catch (cause) {
      const error = Object.assign(new Error(`Selection edit failed: ${cause.message}`), cause);
      const failure =
        SELECTION_EDIT_FAILURE_COPY[cause.messageKey] || SELECTION_EDIT_FAILURE_COPY[cause.code];
      error.code = cause.code || "SELECTION_EDIT_REASONING_FAILED";
      error.messageKey = failure
        ? `hooks.audioRecording.selectionEditing.${failure}`
        : cause.messageKey || "hooks.audioRecording.selectionEditing.reasoningFailed";
      error.selectionEditFatal = true;
      error.cause = cause;
      throw error;
    }

    // The editor judged the command a question about the selection: answer it
    // in the panel with the selection quoted, leaving the selection untouched.
    return this._bankPanelAgentCommand(text, agentName, config, {
      selectedText: capture.text,
    });
  }

  async isReasoningAvailable() {
    if (typeof window === "undefined") {
      return false;
    }

    const s = getSettings();
    const useReasoning =
      !!s.useCleanupModel || dictationAgentReachable(s) || translationChainReachable(s);
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === useReasoning;

    if (cacheValid) {
      return this.reasoningAvailabilityCache.value;
    }

    logger.logReasoning("REASONING_STORAGE_CHECK", {
      useReasoning,
    });

    if (!useReasoning) {
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }

    try {
      const isAvailable = await ReasoningService.isAvailable();

      logger.logReasoning("REASONING_AVAILABILITY", {
        isAvailable,
        reasoningEnabled: useReasoning,
        finalDecision: useReasoning && isAvailable,
      });

      this.reasoningAvailabilityCache = {
        value: isAvailable,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;

      return isAvailable;
    } catch (error) {
      logger.logReasoning("REASONING_AVAILABILITY_ERROR", {
        error: error.message,
        stack: error.stack,
      });

      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }
  }

  // Cleanup-then-translate chain shared by batch and streaming paths: Step 1
  // (optional cleanup) soft-fails to input; Step 2 translates unless source === target.
  async runTranslationChain({ text, settings, agentName, route, cleanup }) {
    const runCleanup = async (currentText) =>
      this.processWithReasoningModel(currentText, cleanup.model, agentName, route.cleanupConfig);

    const runTranslate = async (currentText) =>
      this.processWithReasoningModel(currentText, route.model, agentName, route.config);

    try {
      const chainResult = await executeTranslationChain({
        text,
        cleanupReachable: route.cleanupReachable,
        runCleanup,
        runTranslate,
        shouldTranslate: shouldRunTranslateStep(
          settings.translationSourceLanguage,
          settings.translationTargetLanguage
        ),
        onCleanupError: (cleanupError) => {
          const { level = "error", channel, extra } = cleanup.log || {};
          logger[level](
            "Cleanup step failed in translation chain, translating raw transcript",
            { ...(extra || {}), error: cleanupError.message },
            channel
          );
          // The chain translates the raw transcript, so the dropped cleanup has to
          // surface the same toast the cleanup route raises (#2091).
          this.pendingCleanupFailure = cleanupFailureFromError(cleanupError);
        },
        onEmptyTranslate: () => {
          const { channel } = cleanup.log || {};
          logger.warn("Translation step returned empty text, keeping previous text", {}, channel);
          this.notifyTranslationFallback("failed");
        },
        // No fallback toast here: an echoed translation usually means the dictation was
        // already in the target language, which the current app treats as silent success.
        onUnchangedTranslate: () => {
          const { channel } = cleanup.log || {};
          logger.warn("Translation step returned unchanged text, keeping source text", {}, channel);
        },
      });
      this.translationApplied = chainResult.translated;
      return chainResult;
    } catch (translateError) {
      // Translate step threw: raw text is still pasted by the caller. Surface the failure.
      this.notifyTranslationFallback("failed");
      throw translateError;
    }
  }

  // Runs wherever a dictation's route is decided, with the reachability that
  // decision used. The notice reaches the user through the result extras.
  _noteCleanupRoute(settings, { kind, cleanupReachable }) {
    const { forget, notice } = cleanupUnconfiguredNotice(this._shownCleanupSetupKey, {
      skipped: kind === "skip",
      cleanupReachable,
      settings,
    });
    if (forget) this._shownCleanupSetupKey = null;
    if (notice && !this.pendingCleanupFailure) this.pendingCleanupFailure = notice;
  }

  // The renderer confirms an unconfigured-cleanup notice once it is on screen, so
  // a dictation cancelled or discarded before then never uses up the warning.
  markCleanupNoticeShown(failure) {
    if (failure?.setupKey) this._shownCleanupSetupKey = failure.setupKey;
  }

  async processTranscription(text, source, wasCancelled = neverCancelled) {
    try {
      const result = await this.processTranscriptionCore(text, source, wasCancelled);
      if (wasCancelled()) return result;
      return this.finalizeChineseScript(result);
    } catch (error) {
      attachTranscript(error, text);
      throw error;
    }
  }

  async processTranscriptionCore(text, source, wasCancelled = neverCancelled) {
    const normalizedText = typeof text === "string" ? text.trim() : "";

    if (!normalizedText) {
      logger.logReasoning("TRANSCRIPTION_EMPTY_SKIPPING_REASONING", {
        source,
        reason: "Empty text after normalization",
      });
      return normalizedText;
    }
    if (wasCancelled()) return normalizedText;

    logger.logReasoning("TRANSCRIPTION_RECEIVED", {
      source,
      textLength: normalizedText.length,
      textPreview: normalizedText.substring(0, 100) + (normalizedText.length > 100 ? "..." : ""),
      timestamp: new Date().toISOString(),
    });

    const settings = getSettings();
    const cleanupModel = selectResolvedLLMConfig(settings, "dictationCleanup").model;
    const cleanupProvider = settings.cleanupProvider || "auto";
    const cleanupReachable = cleanupReachableFor(settings);
    const agentReachable = dictationAgentReachable(settings);
    const agentName =
      typeof window !== "undefined" && window.localStorage ? getAgentName() : "OpenWhispr";
    if (
      !cleanupReachable &&
      !agentReachable &&
      !(this.translationRequested && translationChainReachable(settings)) &&
      // A voice-assistant command always routes: standalone commands stream
      // in the panel, which reports a missing model in-conversation.
      !this.voiceAgentRequested
    ) {
      logger.logReasoning("REASONING_SKIPPED", {
        reason: "No cleanup or dictation-agent model available",
      });
      this._noteCleanupRoute(settings, { kind: "skip", cleanupReachable });
      return normalizedText;
    }

    const useReasoning = this.voiceAgentRequested || (await this.isReasoningAvailable());
    if (wasCancelled()) return normalizedText;

    logger.logReasoning("REASONING_CHECK", {
      useReasoning,
      cleanupModel,
      cleanupProvider,
      agentName,
    });
    // Nothing can run cleanup although the assistant could, so no route is decided.
    if (!useReasoning) {
      this._noteCleanupRoute(settings, { kind: "skip", cleanupReachable });
    }

    if (useReasoning) {
      let route;
      try {
        const screenContext = this.voiceAgentRequested ? await this.consumeScreenContext() : null;
        route = resolveReasoningRoute(
          normalizedText,
          settings,
          agentName,
          this.voiceAgentRequested,
          this.translationRequested,
          screenContext
        );
        if (this.translationRequested && route.kind !== "translation") {
          this.notifyTranslationFallback("unreachable");
        }
        this._noteCleanupRoute(settings, route);
        if (route.kind === "skip") return normalizedText;

        if (route.kind === "translation") {
          const { text: translatedText } = await this.runTranslationChain({
            text: normalizedText,
            settings,
            agentName,
            route,
            cleanup: {
              model: cleanupModel,
              log: { level: "warn", channel: "notes", extra: { source } },
            },
          });

          logger.logReasoning("REASONING_SUCCESS", {
            resultLength: translatedText.length,
            resultPreview:
              translatedText.substring(0, 100) + (translatedText.length > 100 ? "..." : ""),
            processingTime: new Date().toISOString(),
          });

          return translatedText;
        }

        const targetModel = route.kind === "agent" ? route.model : cleanupModel;
        const reasoningConfig =
          route.kind === "cleanup"
            ? { ...route.config, toneStyle: await this.consumeToneStyle() }
            : route.config;

        logger.logReasoning("SENDING_TO_REASONING", {
          preparedTextLength: normalizedText.length,
          model: targetModel,
          provider: route.config?.provider || cleanupProvider,
          path: route.kind,
          disableThinking: reasoningConfig?.disableThinking,
        });

        const result =
          route.kind === "agent"
            ? await this.processAgentCommand(
                normalizedText,
                targetModel,
                agentName,
                {
                  ...reasoningConfig,
                  requiresAgent: true,
                },
                wasCancelled
              )
            : await this.processWithReasoningModel(
                normalizedText,
                targetModel,
                agentName,
                reasoningConfig
              );

        logger.logReasoning("REASONING_SUCCESS", {
          resultLength: result.length,
          resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
          processingTime: new Date().toISOString(),
        });

        // A blank reply must not wipe the dictation — keep the transcript (#1616).
        return hasTextContent(result) ? result : normalizedText;
      } catch (error) {
        if (error.selectionEditFatal) throw error;
        if (wasCancelled()) return normalizedText;
        logger.logReasoning("REASONING_FAILED", {
          error: error.message,
          stack: error.stack,
          fallbackToCleanup: true,
        });
        logger.warn("Reasoning failed", { source, error: error.message }, "notes");
        if (route?.kind === "cleanup") this.pendingCleanupFailure = cleanupFailureFromError(error);
        if (route?.kind === "agent") this._notifyAgentReasoningFailed();
      }
    }

    logger.logReasoning("USING_STANDARD_CLEANUP", {
      reason: useReasoning ? "Reasoning failed" : "Reasoning not enabled",
    });

    return normalizedText;
  }

  getCustomDictionaryArray() {
    return getSettings().customDictionary;
  }

  getCustomPrompt() {
    return getSettings().customPrompts.cleanup || undefined;
  }

  async processWithSelfHosted(audioBlob, metadata = {}, wasCancelled = neverCancelled) {
    const timings = {};
    let requestController = null;
    const apiSettings = getSettings();
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(apiSettings));
    const allowLocalFallback = apiSettings.allowLocalFallback;
    const fallbackModel = apiSettings.fallbackWhisperModel || "base";

    try {
      const route = this.resolveSelfHostedRoute(apiSettings);
      const model = route.model || "whisper-1";

      logger.debug(
        "Transcription request starting",
        {
          model,
          blobSize: audioBlob.size,
          blobType: audioBlob.type,
          durationSeconds: metadata.durationSeconds ?? null,
          language,
        },
        "transcription"
      );

      const apiKey = await this.getSelfHostedApiKey();

      // Some servers decode the upload and reject anything that isn't
      // WAV/MP3/FLAC, which Chromium's WebM/Opus recordings always are.
      // Re-encode rather than failing the dictation; a conversion failure falls
      // through to the original bytes so this can only widen what works.
      let uploadAudio = audioBlob;
      if (needsWavConversion(audioBlob.type, audioBlob.size)) {
        try {
          const wavAudio = await convertToWav(audioBlob);
          // Keep compressed recordings usable on servers that already accept
          // them when PCM expansion would exceed the usual upload limit.
          if (wavAudio.size <= WAV_UPLOAD_LIMIT_BYTES) {
            uploadAudio = wavAudio;
          }
          logger.debug(
            "Prepared recording for self-hosted endpoint",
            {
              fromType: audioBlob.type,
              fromSize: audioBlob.size,
              toType: uploadAudio.type,
              toSize: uploadAudio.size,
            },
            "transcription"
          );
        } catch (conversionError) {
          logger.warn(
            "WAV re-encode failed; uploading original container",
            { error: conversionError?.message, type: audioBlob.type },
            "transcription"
          );
        }
      }

      // Decoding can outlive cancellation and a newer recording's request.
      if (wasCancelled()) throw new DOMException("Transcription cancelled", "AbortError");

      const formData = new FormData();
      const mimeType = uploadAudio.type || "audio/webm";
      const extension = audioExtensionForMime(mimeType);
      formData.append("file", uploadAudio, `audio.${extension}`);
      formData.append("model", model);
      if (language) {
        formData.append("language", language);
      }

      const trimmedPrompt = trimDictionaryPrompt(
        this.getWhisperPrompt(apiSettings),
        WHISPER_PROMPT_CHARS
      );
      const dictionaryPrompt = trimmedPrompt.prompt;
      if (dictionaryPrompt) {
        if (trimmedPrompt.truncated) {
          logger.debug(
            "Custom dictionary prompt truncated",
            {
              originalLength: trimmedPrompt.originalLength,
              truncatedLength: dictionaryPrompt.length,
              maxChars: WHISPER_PROMPT_CHARS,
            },
            "transcription"
          );
        }
        formData.append("prompt", dictionaryPrompt);
      }

      const endpoint = route.endpoint;
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      logger.debug(
        "Making transcription API request",
        { endpoint, model, hasApiKey: !!apiKey, mimeType, extension },
        "transcription"
      );

      // Self-hosted errors name "your server" rather than a provider.
      const providerErrorContext = { selfHosted: true, model, surface: "transcription" };
      const apiCallStart = performance.now();
      requestController = new AbortController();
      this._activeTranscriptionAbortController = requestController;
      let response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: formData,
          signal: requestController.signal,
        });
      } catch (err) {
        throw asProviderError(err, providerErrorContext);
      }

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Transcription API error response",
          {
            status: response.status,
            errorText: redactProviderBody(errorText),
          },
          "transcription"
        );
        throw providerHttpError({
          ...providerErrorContext,
          status: response.status,
          body: errorText,
          headers: response.headers,
        });
      }

      const rawBody = await response.text();
      let result;
      try {
        result = JSON.parse(rawBody);
      } catch (parseError) {
        logger.error(
          "Failed to parse JSON response",
          { parseError: parseError.message, rawText: rawBody.substring(0, 500) },
          "transcription"
        );
        throw new Error(`Failed to parse API response: ${parseError.message}`);
      }

      if (!result.text || result.text.trim().length === 0) {
        logger.info(
          "Transcription returned empty - check audio input",
          {
            model,
            endpoint,
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        throw new Error(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }

      if (this.isDictionaryEcho(result.text)) {
        throw dictionaryEchoError();
      }
      timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
      const rawText = this.stripTrailingDictionaryEcho(result.text, dictionaryPrompt);

      const reasoningStart = performance.now();
      const text = await this.processTranscription(rawText, "self-hosted", wasCancelled);
      timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

      const source = (await this.isReasoningAvailable()) ? "self-hosted-reasoned" : "self-hosted";
      logger.debug(
        "Transcription successful",
        {
          originalLength: result.text.length,
          processedLength: text.length,
          source,
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
        },
        "transcription"
      );
      return { success: true, text, rawText, source, timings };
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (error.selectionEditFatal) {
        throw error;
      }
      if (error.message === "No audio detected") {
        throw error;
      }

      if (allowLocalFallback) {
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const options = { model: fallbackModel };
          if (language && language !== "auto") {
            options.language = language;
          }

          const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);

          if (result.success && result.text) {
            const text = await this.processTranscription(
              result.text,
              "local-fallback",
              wasCancelled
            );
            if (text) {
              return { success: true, text, source: "local-fallback" };
            }
          }
          throw error;
        } catch (fallbackError) {
          if (fallbackError.selectionEditFatal) {
            throw fallbackError;
          }
          const wrapped = new Error(
            `Self-hosted transcription failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`
          );
          // The toast renders the server failure, so its message params and details
          // must survive the wrap, or the copy shows a bare "{{provider}}".
          for (const key of IPC_ERROR_FIELDS) {
            if (error[key] !== undefined) wrapped[key] = error[key];
          }
          throw wrapped;
        }
      }
      throw error;
    } finally {
      if (this._activeTranscriptionAbortController === requestController) {
        this._activeTranscriptionAbortController = null;
      }
    }
  }

  resolveSelfHostedRoute(settings) {
    const route = resolveTranscriptionRoute({ settings });
    if (route.transport === "http-batch") {
      logger.debug("STT endpoint resolved", { endpoint: route.endpoint }, "transcription");
      return route;
    }
    const error = new Error(
      route.transport === "error" ? route.message : "Self-hosted transcription is not configured"
    );
    if (route.code) error.code = route.code;
    if (route.messageKey) error.messageKey = route.messageKey;
    throw error;
  }

  async safePaste(text, options = {}) {
    try {
      const result = await window.electronAPI.pasteText(text, options);
      if (
        result?.success === false &&
        result.code === "ACCESSIBILITY_PERMISSION_REQUIRED" &&
        result.clipboardCopied === true
      ) {
        this.onError?.({
          title: "Paste Error",
          code: result.code,
          clipboardCopied: true,
          transcript: text,
        });
        return { pasted: false };
      }
      return {
        pasted: result?.pasted === true,
        ...(result?.reason ? { reason: result.reason } : {}),
      };
    } catch (error) {
      const message =
        error?.message ??
        (typeof error?.toString === "function" ? error.toString() : String(error));
      this.onError?.({
        title: "Paste Error",
        code: "PASTE_FAILED",
        // Keep the platform's guidance, without Electron's IPC wrapper around it.
        description: message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ""),
      });
      return { pasted: false };
    }
  }

  async saveTranscription(
    text,
    rawText = null,
    { clientTranscriptionId, analyticsOccurredAt } = {}
  ) {
    const { dataRetentionEnabled, audioRetentionDays } = getSettings();
    if (!dataRetentionEnabled) {
      logger.debug("Skipping transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return true;
    }

    const eventId = clientTranscriptionId || crypto.randomUUID();
    const occurredAt = analyticsOccurredAt ? new Date(analyticsOccurredAt) : new Date();
    const metadata = this.lastAudioMetadata || {};
    try {
      await window.electronAPI.recordAnalyticsEvent({
        eventId,
        wordCount: countSpokenWords(rawText || text),
        occurredAt: occurredAt.toISOString(),
        localDate: localDateKey(occurredAt),
        spokenDurationMs: metadata.durationMs || null,
        mode: resolveAnalyticsMode(getSettings(), metadata.provider),
        provider: metadata.provider || null,
        model: metadata.model || null,
      });
    } catch (analyticsError) {
      logger.warn(
        "Failed to record local analytics event",
        { error: analyticsError.message },
        "analytics"
      );
    }

    try {
      const result = await window.electronAPI.saveTranscription(text, rawText, {
        clientTranscriptionId: eventId,
        routeKind: this.translationRequested ? "translation" : null,
        analyticsOccurredAt: occurredAt.toISOString(),
      });
      // Save audio if we have a captured blob and the transcription was saved successfully
      if (result?.id && this.lastAudioBlob) {
        if (audioRetentionDays > 0) {
          try {
            const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
            await window.electronAPI.saveTranscriptionAudio(
              result.id,
              arrayBuffer,
              this.lastAudioMetadata
            );
          } catch (audioErr) {
            // Non-blocking: transcription is saved even if audio save fails
            logger.warn("Failed to save transcription audio", { error: audioErr.message }, "audio");
          }
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  async saveFailedTranscription(
    errorMessage,
    errorCode = null,
    metadata = {},
    { transcript = "", clientTranscriptionId } = {}
  ) {
    const { dataRetentionEnabled, audioRetentionDays } = getSettings();
    if (!dataRetentionEnabled) {
      logger.debug("Skipping failed transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return;
    }

    try {
      // Empty when transcription itself failed; otherwise the transcript a later
      // step could not process, kept as both the entry's text and its raw text.
      const keptTranscript = typeof transcript === "string" ? transcript : "";
      const result = await window.electronAPI.saveTranscription(
        keptTranscript,
        keptTranscript || null,
        {
          status: "failed",
          errorMessage,
          errorCode,
          routeKind: this.translationRequested ? "translation" : null,
          ...(clientTranscriptionId ? { clientTranscriptionId } : {}),
          ...(metadata?.analyticsOccurredAt
            ? { analyticsOccurredAt: metadata.analyticsOccurredAt }
            : {}),
        }
      );

      if (result?.id && this.lastAudioBlob) {
        if (audioRetentionDays > 0) {
          try {
            const durationMs = metadata?.durationSeconds
              ? Math.round(metadata.durationSeconds * 1000)
              : null;
            const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
            await window.electronAPI.saveTranscriptionAudio(result.id, arrayBuffer, {
              durationMs,
              provider: null,
              model: null,
            });
          } catch (audioErr) {
            logger.warn(
              "Failed to save audio for failed transcription",
              {
                error: audioErr.message,
              },
              "audio"
            );
          }
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }
    } catch (error) {
      logger.error(
        "Failed to save failed transcription record",
        {
          error: error.message,
        },
        "audio"
      );
    }
  }

  async saveDiscardedTranscription(blob, durationSeconds, analyticsOccurredAt = null) {
    let savedId = null;
    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "discarded",
        routeKind: this.translationRequested ? "translation" : null,
        ...(analyticsOccurredAt ? { analyticsOccurredAt } : {}),
      });
      if (!result?.id) return;
      savedId = result.id;

      if (blob) {
        const durationMs = durationSeconds ? Math.round(durationSeconds * 1000) : null;
        const arrayBuffer = await blob.arrayBuffer();
        await window.electronAPI.saveTranscriptionAudio(savedId, arrayBuffer, {
          durationMs,
          provider: null,
          model: null,
        });
      }
    } catch (error) {
      logger.error(
        "Failed to save discarded transcription record",
        { error: error.message },
        "audio"
      );
      // A discarded row is only recoverable through its audio; if the audio save
      // failed, drop the dead row instead of leaving an empty unrecoverable entry. See #907.
      if (savedId != null) {
        try {
          await window.electronAPI.deleteTranscription(savedId);
        } catch (cleanupError) {
          logger.warn(
            "Failed to clean up discarded row after audio save failure",
            { error: cleanupError.message },
            "audio"
          );
        }
      }
    }
  }

  // Recordings a hung or crashed app never saved come back as failed entries
  // the user can retry. One that fails to save stays spooled for the next
  // launch. Runs at launch, which also opens the spool before any recording.
  async recoverInterruptedRecordings(errorMessage) {
    let recordings;
    try {
      recordings = await takeInterruptedRecordings();
    } catch (error) {
      logger.warn("Failed to read interrupted recordings", { error: error.message }, "audio");
      return;
    }
    const { dataRetentionEnabled, audioRetentionDays } = getSettings();
    const keepAudio = dataRetentionEnabled && audioRetentionDays > 0;
    for (const recording of recordings) {
      if (!keepAudio || (await this._saveInterruptedRecording(recording, errorMessage))) {
        recording.discard();
      }
    }
  }

  async _saveInterruptedRecording({ segments, startedAt, durationMs, routeKind }, errorMessage) {
    let audio;
    try {
      audio = await this.mergeRecordedSegments(segments);
    } catch (error) {
      logger.warn("Failed to merge interrupted recording", { error: error.message }, "audio");
      audio = this.getLargestRecordedSegment(segments);
    }
    // Header-only chunks: the app hung before any audio was captured.
    if (!audio) return true;

    let savedId = null;
    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        status: "failed",
        errorMessage,
        errorCode: "CRASH_RECOVERY",
        routeKind,
        analyticsOccurredAt: new Date(startedAt).toISOString(),
      });
      savedId = result?.id ?? null;
      if (savedId === null) return false;
      const audioResult = await window.electronAPI.saveTranscriptionAudio(
        savedId,
        await audio.arrayBuffer(),
        { durationMs, provider: null, model: null }
      );
      if (!audioResult?.success) throw new Error("Failed to save recovered audio");
      logger.info("Recovered interrupted recording", { id: savedId, durationMs }, "audio");
      return true;
    } catch (error) {
      logger.error("Failed to save interrupted recording", { error: error.message }, "audio");
      // Without its audio the row can't be retried; the next launch tries again.
      if (savedId !== null) {
        await window.electronAPI.deleteTranscription(savedId).catch(() => {});
      }
      return false;
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      micCaptureStatus: this.micCaptureStatus,
    };
  }

  shouldShowPreviewCleanupState() {
    const settings = getSettings();
    return (
      !!settings.useCleanupModel ||
      !!settings.useDictationAgent ||
      (this.translationRequested && !!settings.useDictationTranslation)
    );
  }

  async cleanupPreview(options = {}) {
    const { dismiss = false, showCleanup = false } = options;

    // Claim the session's nodes synchronously so a recording started during the
    // flush await can never have its fresh nodes torn down by this cleanup.
    const processor = this._previewProcessor;
    const source = this._previewSource;
    const audioContext = this._previewAudioContext;
    this._previewProcessor = null;
    this._previewSource = null;
    this._previewAudioContext = null;

    let flushed = true;
    if (processor) {
      // The worklet posts all PCM before "flushed", and the PCM sends share the
      // renderer->main pipe with the stop invoke (FIFO), so the final chunk precedes finish.
      let resolveFlush;
      const flushSentinel = new Promise((resolve) => {
        resolveFlush = () => resolve(true);
      });
      let watchdogTimer;
      const watchdogFired = new Promise((resolve) => {
        watchdogTimer = setTimeout(() => resolve(false), PREVIEW_FLUSH_WATCHDOG_MS);
      });
      this._previewFlushResolve = resolveFlush;
      processor.port.postMessage("stop");
      flushed = await Promise.race([flushSentinel, watchdogFired]);
      clearTimeout(watchdogTimer);
      if (this._previewFlushResolve === resolveFlush) this._previewFlushResolve = null;
      processor.disconnect();
    }
    source?.disconnect();
    audioContext?.close().catch(() => {});
    if (dismiss) {
      window.electronAPI?.dismissDictationPreview?.();
      return null;
    }
    return (await window.electronAPI?.stopDictationPreview?.({ showCleanup, flushed })) || null;
  }

  cleanup() {
    this.micRecovery.stop();
    this._unsubscribeSettings?.();
    this.preparedMicCapture.cancel();
    this._closeBatchPcmTap();
    this.micStreamHold.drop();
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    if (this.mediaRecorder?.state === "recording") {
      this.stopRecording();
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    if (this._onDeviceChange) {
      navigator.mediaDevices?.removeEventListener?.("devicechange", this._onDeviceChange);
    }
  }
}

export { resolveReasoningRoute };
export default AudioManager;
