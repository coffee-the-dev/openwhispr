import type { ModelDefinition } from "../models/ModelRegistry";
import type { CalendarAvailabilityRequest, CalendarAvailabilityResult } from "./calendar";

export type LocalTranscriptionProvider = "whisper" | "nvidia" | "cohere";

export interface MainWindowInputRegion {
  viewportWidth: number;
  viewportHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ChineseScriptPreference = "simplified" | "traditional" | "as-transcribed";

export type InferenceMode = "local" | "self-hosted";

export type TranscriptionMode = "local" | "self-hosted";

/** Each LLM scope's resolved mode and model, from which the main process decides the shared llama-server. */
export interface LocalServerPrefs {
  useCleanupModel: boolean;
  cleanupMode: InferenceMode;
  cleanupModel: string;
  useDictationAgent: boolean;
  dictationAgentMode: InferenceMode;
  dictationAgentModel: string;
  noteFormattingMode: InferenceMode;
  noteFormattingModel: string;
  chatAgentMode: InferenceMode;
  chatAgentModel: string;
  useDictationTranslation: boolean;
  translationMode: InferenceMode;
  translationModel: string;
}

export type SelfHostedType = "openai-compatible" | "lan";

export type TranscriptionStatus = "completed" | "failed" | "pending" | "discarded";

export type TranscriptionErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER_ERROR"
  | "OFFLINE"
  | "AUTH_EXPIRED"
  | "AUTH_REQUIRED"
  | "LIMIT_REACHED"
  | "PROVIDER_RATE_LIMITED"
  | "API_KEY_MISSING"
  | "INVALID_KEY"
  | "MODEL_NOT_AVAILABLE"
  | "CUSTOM_ENDPOINT_INVALID"
  | null;

export type MeetingPromptVariant = "detected" | "starting" | "underway";

export interface MeetingNotificationData {
  detectionId: string;
  source: string;
  key: string;
  event: { summary?: string | null } | null;
  variant: MeetingPromptVariant;
  joinUrl: string | null;
}

/** Why auto-end concluded the meeting is over. */
export type MeetingAutoEndReason = "mic-released" | "silence" | "process-exit";

export interface MeetingAutoEndRequest {
  sessionId: string;
  reason?: MeetingAutoEndReason;
}

/**
 * Proxied-transcription IPC results. `ipcMain.handle` drops custom error props on
 * rejection, so these handlers resolve with a serialized error instead of throwing.
 */
export type ProxyTranscriptionResult =
  | { text: string; model?: string; error?: undefined }
  | { error: string; code?: string; messageKey?: string; text?: undefined };

export interface TranscriptionItem {
  id: number;
  text: string;
  raw_text: string | null;
  timestamp: string;
  created_at: string;
  has_audio: number;
  audio_duration_ms: number | null;
  provider: string | null;
  model: string | null;
  status: TranscriptionStatus;
  error_message: string | null;
  error_code: TranscriptionErrorCode;
  route_kind?: string | null;
  client_transcription_id: string;
}

export type AnalyticsMode = "local" | "openwhispr_cloud" | "byok" | "self_hosted" | "unknown";

export interface AnalyticsEventInput {
  eventId: string;
  wordCount: number;
  occurredAt: string;
  localDate: string;
  spokenDurationMs?: number | null;
  mode: AnalyticsMode;
  provider?: string | null;
  model?: string | null;
}

export interface AnalyticsDailyBucket {
  date: string;
  words: number;
  dictations: number;
  spokenDurationMs: number;
}

export interface AnalyticsSummary {
  totalWords: number;
  totalDictations: number;
  totalSpokenDurationMs: number;
  averageWpm: number | null;
  currentStreakDays: number;
  longestStreakDays: number;
  wpmCoveragePercent: number;
  daily: AnalyticsDailyBucket[];
}

export interface NoteItem {
  id: number;
  title: string;
  content: string;
  enhanced_content: string | null;
  enhancement_prompt: string | null;
  enhanced_at_content_hash: string | null;
  note_type: "personal" | "meeting" | "upload";
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: number | null;
  space_id: number;
  transcript: string | null;
  calendar_event_id: string | null;
  participants: string | null;
  diarization_enabled: number | null;
  expected_speaker_count: number | null;
  created_at: string;
  updated_at: string;
  client_note_id: string;
}

export interface FolderItem {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  space_id: number;
  created_at: string;
  updated_at: string;
  client_folder_id: string;
}

export interface SpaceItem {
  id: number;
  client_space_id: string;
  kind: "private";
  name: string;
  emoji: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ActionItem {
  id: number;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  is_builtin: number;
  sort_order: number;
  translation_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface GpuDevice {
  index: number;
  uuid: string;
  name: string;
  vramMb: number;
}

export interface GpuInfo {
  hasNvidiaGpu: boolean;
  gpuName?: string;
  driverVersion?: string;
  vramMb?: number;
  computeCap?: number;
  /** Whether the card meets the shipped CUDA build's minimum compute capability. */
  cudaSupported?: boolean;
}

export interface CudaWhisperStatus {
  downloaded: boolean;
  downloading: boolean;
  path: string | null;
  gpuInfo: GpuInfo;
  /** CUDA fell back to CPU on this machine and stays off until retried. */
  gpuFailed?: boolean;
}

export interface VulkanWhisperStatus {
  downloaded: boolean;
  downloading: boolean;
  vulkan: VulkanGpuResult;
  hasNvidiaGpu: boolean;
  /** Vulkan fell back to CPU on this machine and stays off until retried. */
  gpuFailed?: boolean;
}

export interface WhisperServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  hostname: string;
  isRemote: boolean;
  modelPath: string | null;
  modelName: string | null;
  gpuBackend: "cuda" | "vulkan" | null;
  /** True only when the running server is actually using a local GPU backend. */
  gpuAccelerated: boolean;
}

export interface WhisperCheckResult {
  installed: boolean;
  working: boolean;
  error?: string;
}

export interface WhisperModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  size_mb?: number;
  error?: string;
  code?: string;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface WhisperModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_mb?: number;
  error?: string;
}

export interface WhisperModelsListResult {
  success: boolean;
  models: WhisperModelResult[];
  cache_dir: string;
}

export interface FFmpegAvailabilityResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface AudioDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  ffmpeg: { available: boolean; path: string | null; error: string | null };
  whisperBinary: { available: boolean; path: string | null; error: string | null };
  whisperServer: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export type SystemAudioMode = "native" | "loopback" | "portal" | "unsupported";
export type SystemAudioStrategy =
  "native" | "loopback" | "pipewire-loopback" | "wasapi-loopback" | "unsupported";

export interface MeetingSystemAudioInterruption {
  systemAudioStrategy: SystemAudioStrategy;
  reason: "no_audio_delivered" | "device_invalidated" | "gone_quiet";
  recovering: boolean;
}

export interface SystemAudioAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  mode: SystemAudioMode;
  supportsPersistentGrant?: boolean;
  supportsPersistentPortalGrant?: boolean;
  supportsNativeCapture?: boolean;
  supportsOnboardingGrant?: boolean;
  requiresRuntimeSharePrompt?: boolean;
  strategy?: SystemAudioStrategy;
  restoreTokenAvailable?: boolean;
  portalVersion?: number | null;
  error?: string;
}

export interface ScreenRecordingAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  supported: boolean;
  /** macOS only: granted mid-session, so capture stays broken until the app relaunches. */
  needsRelaunch?: boolean;
}

export interface ScreenContextImage {
  mediaType: string;
  /** Base64 image bytes, no data-URL prefix. */
  data: string;
}

export interface AppVersionResult {
  version: string;
}

export interface WhisperDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  result?: any;
  sequence?: number;
}

export interface LocalModelDownloadStatus {
  modelType: "whisper" | "parakeet" | "llm";
  modelId: string;
  phase: "downloading" | "installing";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  sequence: number;
}

export interface ParakeetCheckResult {
  installed: boolean;
  working: boolean;
  supported?: boolean;
  path?: string;
  code?: string;
  message?: string;
  minimumMacOSVersion?: string;
}

export interface ParakeetModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  error?: string;
  code?: string;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface ParakeetModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface ParakeetModelsListResult {
  success: boolean;
  models: ParakeetModelResult[];
  cache_dir: string;
}

export interface ParakeetDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  sequence?: number;
}

export interface ParakeetTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface ParakeetDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  sherpaOnnx: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  terminalAware?: boolean;
  hasNativeBinary?: boolean;
  hasUinput?: boolean;
  hasWtype?: boolean;
  isWlroots?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

export type GpuBackend = "vulkan" | "cpu" | "metal" | null;

export interface LlamaServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  backend: GpuBackend;
  gpuAccelerated: boolean;
}

export interface VulkanGpuResult {
  available: boolean;
  deviceName?: string;
  reason?: string;
  error?: string;
}

export interface LlamaVulkanStatus {
  supported: boolean;
  downloaded: boolean;
  downloading?: boolean;
  error?: string;
}

export interface LlamaVulkanDownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
}

export interface LocalLLMModelStatus extends ModelDefinition {
  providerId?: string;
  providerName?: string;
  isDownloaded: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  downloadedSize: number;
  totalSize: number;
  path: string | null;
}

export type LocalLLMDownloadProgressEvent =
  | {
      type?: "progress";
      modelId: string;
      progress: number;
      downloadedSize: number;
      totalSize: number;
      sequence?: number;
    }
  | {
      type: "complete";
      modelId: string;
      progress: 100;
      downloadedSize?: number;
      totalSize?: number;
      sequence?: number;
    }
  | {
      type: "error";
      modelId: string;
      error: string;
      code?: string;
      details?: unknown;
      sequence?: number;
    };

export interface ConversationPreview {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  client_conversation_id?: string;
  message_count: number;
  last_message?: string | null;
  last_message_role?: "user" | "assistant" | "system" | null;
}

export type OnboardingDemoKind = "dictation" | "assistant";
/**
 * "partial" streams the transcript, "processing" carries the final transcript,
 * "replying" streams the assistant demo's reply, and "level" mirrors the
 * microphone level while listening.
 */
export type OnboardingDemoStatus =
  "listening" | "level" | "processing" | "partial" | "replying" | "success" | "error";
export interface OnboardingDemoEvent {
  demoId: string;
  kind: OnboardingDemoKind;
  status: OnboardingDemoStatus;
  text?: string;
  message?: string;
  /** Tool the assistant is running while it replies (a tool registry name). */
  tool?: string;
  /** Microphone input level, 0..1, on "level" events. */
  level?: number;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      setOnboardingWindowMode?: (mode: "compact" | "expanded" | "restore") => Promise<boolean>;
      setOnboardingActive?: (active: boolean) => Promise<boolean>;
      beginOnboardingDemo?: (session: { id: string; kind: OnboardingDemoKind }) => Promise<boolean>;
      endOnboardingDemo?: (id: string) => Promise<boolean>;
      stopOnboardingDemo?: (id: string) => Promise<boolean>;
      publishOnboardingDemoEvent?: (event: Omit<OnboardingDemoEvent, "demoId">) => Promise<boolean>;
      onOnboardingDemoEvent?: (callback: (event: OnboardingDemoEvent) => void) => () => void;
      testProviderConnection?: (config: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      }) => Promise<{ success: boolean; error?: string; errorCode?: string; status?: number }>;
      listRemoteModels?: (config: { apiKey?: string; baseUrl?: string }) => Promise<{
        success: boolean;
        models: string[];
        error?: string;
        errorCode?: string;
        status?: number;
      }>;
      pasteText: (
        text: string,
        options?: {
          restoreClipboard?: boolean;
          allowClipboardFallback?: boolean;
        }
      ) => Promise<
        | { success: true; pasted: boolean }
        | {
            success: false;
            pasted: false;
            code: "ACCESSIBILITY_PERMISSION_REQUIRED";
            clipboardCopied: true;
          }
      >;
      captureSelectedText?: (options?: { probeEditable?: boolean }) => Promise<
        | {
            status: "selected";
            sessionId: string;
            text: string;
            characterCount: number;
          }
        | {
            status: "editable";
            sessionId: string;
            /** True when the captured app keeps markdown (spec Appendix A); false means plain text. */
            acceptsMarkdown: boolean;
          }
        | {
            status: "none" | "unavailable" | "target_changed" | "too_large";
            code?: string;
            characterCount?: number;
            maxCharacters?: number;
          }
      >;
      replaceSelectedText?: (
        sessionId: string,
        text: string,
        options?: { restoreClipboard?: boolean; allowClipboardFallback?: boolean }
      ) => Promise<{
        success: boolean;
        code?:
          | "invalid_replacement"
          | "session_expired"
          | "target_changed"
          | "selection_unavailable"
          | "selection_changed"
          | "paste_failed"
          | "selection_manager_unavailable";
        error?: string;
      }>;
      pasteAtCapturedTarget?: (
        sessionId: string,
        text: string,
        options?: { restoreClipboard?: boolean; allowClipboardFallback?: boolean }
      ) => Promise<{
        success: boolean;
        code?:
          | "invalid_replacement"
          | "session_expired"
          | "target_changed"
          | "paste_failed"
          | "selection_manager_unavailable";
        error?: string;
      }>;
      hideWindow: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      captureDictationTarget?: () => Promise<{ success: boolean; pid: number | null }>;
      onToggleDictation: (callback: () => void) => () => void;
      onToggleVoiceAgent?: (callback: () => void) => () => void;
      onToggleTranslation?: (callback: () => void) => () => void;
      onOpenAssistantPanel?: (callback: () => void) => () => void;
      onStartDictation?: (callback: () => void) => () => void;
      onStopDictation?: (callback: () => void) => () => void;
      onPrepareDictation?: (
        callback: (options?: { inputKind?: "dictation" | "assistant" | "translation" }) => void
      ) => () => void;
      onCancelDictationPreparation?: (callback: () => void) => () => void;
      onCancelDictation?: (callback: () => void) => () => void;
      onDictationForceStopped?: (
        callback: (payload?: { reason?: "timeout" | "reset" | "manual" }) => void
      ) => () => void;
      micWarmHoldChanged?: (active: boolean) => void;
      dictationLifecycleStateChanged: (
        state: "idle" | "preparing" | "recording" | "processing",
        inputKind?: "dictation" | "assistant" | "translation"
      ) => void;
      dictationAudioLevelChanged?: (level: number) => void;
      toggleAgentPanelDictation?: () => Promise<{ success: boolean }>;
      cancelAgentPanelDictation?: () => Promise<{ success: boolean }>;
      getAgentDictationPillState?: () => Promise<{
        lifecycle: "idle" | "preparing" | "recording" | "processing";
        interactive: boolean;
        horizontalDirection: "left" | "right";
      }>;
      resizeAgentDictationPillToContent?: (surfaceHeight: number | null) => Promise<{
        success: boolean;
        changed?: boolean;
        bounds?: { x: number; y: number; width: number; height: number };
        message?: string;
      }>;
      setAgentDictationPillInteractivity?: (interactive: boolean) => Promise<{ success: boolean }>;
      onAgentDictationPillStateChanged?: (
        callback: (state: {
          lifecycle: "idle" | "preparing" | "recording" | "processing";
          interactive: boolean;
          horizontalDirection: "left" | "right";
        }) => void
      ) => () => void;
      onAgentDictationPillAudioLevelChanged?: (callback: (level: number) => void) => () => void;
      showAgentDictationFinalTranscript?: (text: string) => void;
      onAgentDictationPillFinalTranscript?: (callback: (text: string) => void) => () => void;

      // Database operations
      saveTranscription: (
        text: string,
        rawText?: string | null,
        options?: {
          status?: TranscriptionStatus;
          errorMessage?: string | null;
          errorCode?: TranscriptionErrorCode;
          clientTranscriptionId?: string;
          analyticsOccurredAt?: string;
        }
      ) => Promise<{ id: number; success: boolean; transcription?: TranscriptionItem }>;
      getTranscriptions: (
        limit?: number,
        options?: { includeDiscarded?: boolean }
      ) => Promise<TranscriptionItem[]>;
      recordAnalyticsEvent: (
        input: AnalyticsEventInput
      ) => Promise<{ success: boolean; eventId?: string; ignored?: boolean }>;
      getAnalyticsSummary: () => Promise<AnalyticsSummary>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      getTranscriptionById: (id: number) => Promise<TranscriptionItem | null>;

      // Audio retention operations
      saveTranscriptionAudio: (
        id: number,
        audioBuffer: ArrayBuffer,
        metadata?: { durationMs?: number; provider?: string; model?: string }
      ) => Promise<{ success: boolean; path?: string }>;
      mergeAudioSegments: (
        segments: Array<{ buffer: ArrayBuffer; mimeType: string }>
      ) => Promise<
        | { success: true; buffer: ArrayBuffer; mimeType: "audio/webm" }
        | { success: false; error: string }
      >;
      getAudioPath: (id: number) => Promise<string | null>;
      showAudioInFolder: (id: number) => Promise<{ success: boolean }>;
      getAudioBuffer: (id: number) => Promise<ArrayBuffer | null>;
      deleteTranscriptionAudio: (id: number) => Promise<{ success: boolean }>;
      getAudioStorageUsage: () => Promise<{ fileCount: number; totalBytes: number }>;
      deleteAllAudio: () => Promise<{ deleted: number }>;
      syncRetentionSettings?: (settings: {
        audioRetentionDays: number;
        transcriptRetentionDays: number;
        dataRetentionEnabled: boolean;
      }) => void;
      retryTranscription: (
        id: number,
        settings?: {
          useLocalWhisper: boolean;
          localTranscriptionProvider: string;
          parakeetModel: string;
          cohereModel: string;
          whisperModel: string;
          preferredLanguage?: string;
          transcriptionMode?: TranscriptionMode;
          remoteTranscriptionType?: SelfHostedType;
          remoteTranscriptionUrl?: string;
          remoteTranscriptionModel?: string;
        }
      ) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        error?: string;
        code?: TranscriptionErrorCode;
        messageKey?: string;
      }>;
      updateTranscriptionText: (
        id: number,
        text: string,
        rawText: string
      ) => Promise<{ success: boolean; transcription?: TranscriptionItem; error?: string }>;

      // Dictionary operations
      getDictionary: () => Promise<string[]>;
      /** Replaces the whole dictionary — omitted words are deleted. Prefer applyDictionaryChanges. */
      setDictionary: (words: string[]) => Promise<{ success: boolean }>;
      applyDictionaryChanges?: (changes: {
        add?: string[];
        remove?: string[];
      }) => Promise<{ success: boolean; added: number; removed: number }>;
      onDictionaryUpdated?: (callback: (words: string[]) => void) => () => void;
      getSnippets?: () => Promise<Array<{ trigger: string; replacement: string }>>;
      setSnippets?: (
        snippets: Array<{ trigger: string; replacement: string }>
      ) => Promise<{ success: boolean }>;
      onSnippetsUpdated?: (
        callback: (snippets: Array<{ trigger: string; replacement: string }>) => void
      ) => () => void;
      setAutoLearnEnabled?: (enabled: boolean) => void;
      onCorrectionsLearned?: (callback: (words: string[]) => void) => () => void;
      undoLearnedCorrections?: (words: string[]) => Promise<{ success: boolean }>;

      // Note operations
      saveNote: (
        title: string,
        content: string,
        noteType?: string,
        sourceFile?: string | null,
        audioDuration?: number | null,
        folderId?: number | null,
        spaceId?: number | null
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      getNote: (id: number) => Promise<NoteItem | null>;
      getNotes: (
        noteType?: string | null,
        limit?: number,
        folderId?: number | null,
        spaceId?: number | null
      ) => Promise<NoteItem[]>;
      getSpaceNotes: (spaceId: number, limit?: number) => Promise<NoteItem[]>;
      updateNote: (
        id: number,
        updates: {
          title?: string;
          content?: string;
          enhanced_content?: string | null;
          enhancement_prompt?: string | null;
          enhanced_at_content_hash?: string | null;
          folder_id?: number | null;
          space_id?: number;
          transcript?: string | null;
          calendar_event_id?: string | null;
          participants?: string | null;
          diarization_enabled?: number | null;
          expected_speaker_count?: number | null;
          client_note_id?: string;
        }
      ) => Promise<{ success: boolean; note?: NoteItem; error?: string }>;
      deleteNote: (id: number) => Promise<{ success: boolean }>;
      exportNote: (
        noteId: number,
        format: "txt" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportTranscript: (
        noteId: number,
        format: "txt" | "srt" | "json" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportDictionary: (words: string[]) => Promise<{ success: boolean; error?: string }>;
      searchNotes: (
        query: string,
        limit?: number,
        spaceId?: number | null,
        folderId?: number | null
      ) => Promise<NoteItem[]>;
      semanticSearchNotes: (
        query: string,
        limit?: number,
        spaceId?: number | null,
        folderId?: number | null
      ) => Promise<NoteItem[]>;

      // Folder operations
      getFolders: (spaceId?: number | null) => Promise<FolderItem[]>;
      createFolder: (
        name: string,
        spaceId?: number | null
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      deleteFolder: (id: number) => Promise<{ success: boolean; error?: string }>;
      renameFolder: (
        id: number,
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      getFolderNoteCounts: () => Promise<
        Array<{ space_id: number; folder_id: number | null; count: number }>
      >;

      // Space operations
      getSpaces?: () => Promise<SpaceItem[]>;

      // Note files (markdown mirror)
      noteFilesSetEnabled?: (
        enabled: boolean,
        customPath?: string,
        options?: { skipRebuild?: boolean; baseTag?: string; exportDictations?: boolean }
      ) => Promise<{ success: boolean; error?: string }>;
      noteFilesSetPath?: (path: string) => Promise<{ success: boolean; error?: string }>;
      noteFilesRebuild?: () => Promise<{ success: boolean; error?: string }>;
      noteFilesGetDefaultPath?: () => Promise<string>;
      noteFilesPickFolder?: () => Promise<{ canceled: boolean; path?: string }>;
      noteFilesSetOptions?: (options: {
        baseTag?: string;
        exportDictations?: boolean;
      }) => Promise<{ success: boolean; error?: string }>;
      noteFilesGetResolvedPaths?: () => Promise<{
        basePath: string;
        meetingsPath: string | null;
        dictationsPath: string | null;
      } | null>;
      noteFilesHasNoteFile?: (noteId: number) => Promise<boolean>;
      noteFilesOpenInObsidian?: (noteId: number) => Promise<{ success: boolean }>;
      granolaImportPickAndPreview?: () => Promise<{
        canceled: boolean;
        success?: boolean;
        error?: string;
        fileName?: string;
        total?: number;
        newCount?: number;
        duplicateCount?: number;
        sampleTitles?: string[];
        rowIssueCount?: number;
      }>;
      granolaImportRun?: () => Promise<{
        success: boolean;
        error?: string;
        imported?: number;
        skipped?: number;
        errors?: Array<{ clientNoteId: string; error: string }>;
      }>;
      showNoteFile?: (noteId: number) => Promise<{ success: boolean }>;
      showFolderInExplorer?: (folderName: string) => Promise<{ success: boolean }>;

      // Action operations
      getActions: () => Promise<ActionItem[]>;
      getAction: (id: number) => Promise<ActionItem | null>;
      createAction: (
        name: string,
        description: string,
        prompt: string,
        icon?: string
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      updateAction: (
        id: number,
        updates: {
          name?: string;
          description?: string;
          prompt?: string;
          icon?: string;
          sort_order?: number;
        }
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      deleteAction: (id: number) => Promise<{ success: boolean; id?: number; error?: string }>;
      onActionCreated?: (callback: (action: ActionItem) => void) => () => void;
      onActionUpdated?: (callback: (action: ActionItem) => void) => () => void;
      onActionDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Audio file operations
      saveTempAudio: (buffer: ArrayBuffer) => Promise<{ success: boolean; path: string }>;
      deleteTempAudio: (tempPath: string) => Promise<{ success: boolean; error?: string }>;
      selectAudioFile: (options?: { multiple?: boolean }) => Promise<{
        canceled: boolean;
        filePath?: string;
        filePaths?: string[];
      }>;
      getFileSize?: (filePath: string) => Promise<number>;
      transcribeAudioFile: (
        filePath: string,
        options?: {
          provider?: LocalTranscriptionProvider;
          model?: string;
          language?: string;
          requestId?: string;
          [key: string]: unknown;
        }
      ) => Promise<{ success: boolean; text?: string; error?: string; code?: string }>;
      getPathForFile: (file: File) => string;

      // URL audio download
      downloadUrlAudio: (
        url: string,
        downloadId?: string
      ) => Promise<
        | {
            success: true;
            tempPath: string;
            title: string;
            durationSeconds: number | null;
            sizeBytes: number;
          }
        | { success: false; error: string; code?: string }
      >;
      cancelUrlDownload: (downloadId?: string) => Promise<{ success: boolean }>;
      deleteTempFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      onUrlDownloadProgress?: (
        callback: (data: {
          stage: "resolving" | "downloading" | "ready";
          percent: number;
          title?: string;
          downloadId?: string;
        }) => void
      ) => () => void;

      // Note event listeners
      onNoteAdded?: (callback: (note: NoteItem) => void) => () => void;
      onNoteUpdated?: (callback: (note: NoteItem) => void) => () => void;
      onNoteDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onFolderDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionUpdated?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;
      onAnalyticsChanged?: (callback: () => void) => () => void;

      getUiLanguage: () => Promise<string>;
      saveUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      setUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      saveAllKeysToEnv: () => Promise<{ success: boolean; path: string }>;
      syncStartupPreferences: (
        prefs: LocalServerPrefs & {
          useLocalWhisper: boolean;
          localTranscriptionProvider: LocalTranscriptionProvider;
          model?: string;
          language?: string;
        }
      ) => Promise<void>;

      // Clipboard operations
      checkAccessibilityPermission: (silent?: boolean) => Promise<boolean>;
      promptAccessibilityPermission: () => Promise<boolean>;
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      checkPasteTools: () => Promise<PasteToolsResult>;

      // Audio

      // Whisper operations (whisper.cpp)
      transcribeLocalWhisper: (audioBlob: Blob | ArrayBuffer, options?: any) => Promise<any>;
      checkWhisperInstallation: () => Promise<WhisperCheckResult>;
      downloadWhisperModel: (modelName: string) => Promise<WhisperModelResult>;
      onWhisperDownloadProgress: (
        callback: (event: any, data: WhisperDownloadProgressData) => void
      ) => () => void;
      checkModelStatus: (modelName: string) => Promise<WhisperModelResult>;
      listWhisperModels: () => Promise<WhisperModelsListResult>;
      deleteWhisperModel: (modelName: string) => Promise<WhisperModelDeleteResult>;
      deleteAllWhisperModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelWhisperDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;

      // Whisper server lifecycle
      whisperServerStatus: () => Promise<WhisperServerStatus>;
      whisperGpuRetry: () => Promise<{ success: boolean; willRestart: boolean }>;

      // CUDA GPU acceleration
      listGpus?: () => Promise<GpuDevice[]>;
      setGpuDeviceIndex?: (
        purpose: "transcription" | "intelligence",
        uuid: string
      ) => Promise<{ success: boolean }>;
      getGpuDeviceIndex?: (purpose: "transcription" | "intelligence") => Promise<string>;
      detectGpu: () => Promise<GpuInfo>;
      getCudaWhisperStatus: () => Promise<CudaWhisperStatus>;
      downloadCudaWhisperBinary: () => Promise<{
        success: boolean;
        willRestart?: boolean;
        error?: string;
      }>;
      cancelCudaWhisperDownload: () => Promise<{ success: boolean }>;
      deleteCudaWhisperBinary: () => Promise<{ success: boolean }>;
      onCudaDownloadProgress: (
        callback: (data: {
          downloadedBytes: number;
          totalBytes: number;
          percentage: number;
        }) => void
      ) => () => void;
      onCudaFallbackNotification: (callback: () => void) => () => void;

      // Vulkan GPU acceleration (whisper on AMD/Intel GPUs)
      getVulkanWhisperStatus: () => Promise<VulkanWhisperStatus>;
      downloadVulkanWhisperBinary: () => Promise<{
        success: boolean;
        willRestart?: boolean;
        error?: string;
      }>;
      cancelVulkanWhisperDownload: () => Promise<{ success: boolean }>;
      deleteVulkanWhisperBinary: () => Promise<{ success: boolean; deletedCount?: number }>;
      onVulkanWhisperDownloadProgress: (
        callback: (data: {
          downloadedBytes: number;
          totalBytes: number;
          percentage: number;
        }) => void
      ) => () => void;
      onGpuFallbackNotification: (callback: () => void) => () => void;

      // One-time "GPU pack needs re-downloading" notice from the legacy-layout migration
      getGpuPackMigrationNotice: () => Promise<{ packs: string[] } | null>;
      dismissGpuPackMigrationNotice: () => Promise<{ success: boolean }>;

      // Parakeet operations (NVIDIA via sherpa-onnx)
      transcribeLocalParakeet: (
        audioBlob: ArrayBuffer,
        options?: { model?: string; language?: string }
      ) => Promise<ParakeetTranscriptionResult>;
      checkParakeetInstallation: () => Promise<ParakeetCheckResult>;
      downloadParakeetModel: (modelName: string) => Promise<ParakeetModelResult>;
      onParakeetDownloadProgress: (
        callback: (event: any, data: ParakeetDownloadProgressData) => void
      ) => () => void;
      checkParakeetModelStatus: (modelName: string) => Promise<ParakeetModelResult>;
      listParakeetModels: () => Promise<ParakeetModelsListResult>;
      deleteParakeetModel: (modelName: string) => Promise<ParakeetModelDeleteResult>;
      deleteAllParakeetModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelParakeetDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      getParakeetDiagnostics: () => Promise<ParakeetDiagnosticsResult>;

      // Local AI model management
      modelGetAll: () => Promise<LocalLLMModelStatus[]>;
      modelGetActiveDownloads: () => Promise<LocalModelDownloadStatus[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelDownload: (modelId: string) => Promise<{
        success: boolean;
        path?: string;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDelete: (modelId: string) => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDeleteAll: () => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>;
      onModelDownloadProgress: (
        callback: (event: any, data: LocalLLMDownloadProgressEvent) => void
      ) => () => void;

      // Local reasoning
      processLocalReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{
        success: boolean;
        text?: string;
        error?: string;
        code?: string;
        details?: Record<string, unknown>;
      }>;
      checkLocalReasoningAvailable: () => Promise<boolean>;
      /** The largest context this machine can give a bundled model; drives chunked note generation. */
      getLocalContextBudget: (modelId: string) => Promise<{
        success: boolean;
        maxContextTokens?: number;
        modelName?: string;
        error?: string;
      }>;
      /** Aborts the local request tagged with this `requestId`, if it is still in flight. */
      cancelLocalReasoning: (requestId: string) => Promise<void>;

      // llama.cpp management
      llamaCppCheck: () => Promise<{ isInstalled: boolean; version?: string }>;
      llamaCppInstall: () => Promise<{ success: boolean; error?: string }>;
      llamaCppUninstall: () => Promise<{ success: boolean; error?: string }>;

      // llama-server
      llamaServerStart: (
        modelId: string
      ) => Promise<{ success: boolean; port?: number; error?: string }>;
      llamaServerStatus: () => Promise<LlamaServerStatus>;
      llamaGpuReset: () => Promise<{ success: boolean; error?: string }>;
      detectVulkanGpu?: () => Promise<VulkanGpuResult>;
      getLlamaVulkanStatus?: () => Promise<LlamaVulkanStatus>;
      downloadLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        cancelled?: boolean;
        error?: string;
      }>;
      cancelLlamaVulkanDownload?: () => Promise<{ success: boolean }>;
      deleteLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        deletedCount?: number;
        error?: string;
      }>;
      onLlamaVulkanDownloadProgress?: (
        callback: (data: LlamaVulkanDownloadProgress) => void
      ) => () => void;

      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      snapToMeetingMode: () => Promise<void>;
      restoreFromMeetingMode: () => Promise<void>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      startControlPanelDrag: () => Promise<void>;
      stopControlPanelDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;
      setMainWindowInputRegion: (region: MainWindowInputRegion | null) => Promise<boolean>;
      onMainWindowVisibilityChanged: (callback: (visible: boolean) => void) => () => void;
      setNotificationInteractivity: (interactive: boolean) => Promise<void>;
      resizeMainWindow: (
        sizeKey:
          | "BASE"
          | "RECORDING"
          | "DICTATION_ERROR"
          | "DICTATION_ERROR_WITH_TRANSCRIPT"
          | "WITH_MENU"
          | "WITH_TOAST"
          | "EXPANDED"
          | "ASSISTANT"
      ) => Promise<{
        success: boolean;
        bounds?: Electron.Rectangle;
        message?: string;
        changed?: boolean;
      }>;
      resizeAssistantWindowToContent: (surfaceHeight: number) => Promise<{
        success: boolean;
        bounds?: Electron.Rectangle;
        message?: string;
        changed?: boolean;
      }>;
      resizeDictationErrorWindowToContent: (
        surfaceHeight: number
      ) => Promise<{ success: boolean; bounds?: Electron.Rectangle; message?: string }>;
      setAssistantPanelOpen: (open: boolean) => Promise<{ success: boolean }>;
      setAssistantPanelBusy: (busy: boolean) => Promise<{ success: boolean }>;

      // App management
      cleanupApp: () => Promise<{ success: boolean; message: string; errors?: string[] }>;
      relaunchApp: () => Promise<void>;

      getAppVersion: () => Promise<AppVersionResult>;
      getPostMigrationState: () => Promise<{ justMigrated: boolean }>;
      markBundleMigrated: () => Promise<void>;
      markBundleMigrationDismissed: () => Promise<void>;

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      setHotkeyListeningMode?: (enabled: boolean) => Promise<{ success: boolean }>;
      getHotkeyModeInfo?: (hotkey?: string) => Promise<{
        isUsingGnome: boolean;
        isUsingHyprland: boolean;
        isUsingKDE: boolean;
        isUsingNativeShortcut: boolean;
        supportsPushToTalk: boolean;
        pushToTalkUnavailableReason: string | null;
        linuxInputAccessDenied?: boolean;
      }>;
      getHyprlandConfigStatus?: () => Promise<{ canWrite: boolean; path: string } | null>;

      // Wayland paste diagnostics
      getYdotoolStatus?: () => Promise<{
        isLinux: boolean;
        isWayland: boolean;
        hasYdotool: boolean;
        hasYdotoold: boolean;
        hasWtype: boolean;
        daemonRunning: boolean;
        hasService: boolean;
        hasUinput: boolean;
        hasUdevRule: boolean;
        hasGroup: boolean;
        isNixOS: boolean;
        isKde: boolean;
        isWlroots: boolean;
        hasXclip: boolean;
        hasXsel: boolean;
      }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;
      onGlobeKeyReleased?: (callback: () => void) => () => void;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;
      onSettingUpdated?: (callback: (data: { key: string; value: unknown }) => void) => () => void;
      onDictationKeyActive?: (callback: (key: string) => void) => () => void;
      onLinuxPttPermissionDenied?: (callback: () => void) => () => void;

      // Settings shortcut (Cmd+, / Ctrl+,)
      onShowSettings?: (callback: () => void) => () => void;

      // Accessibility permission events (macOS)
      markMacAccessibilityFeaturesReady?: () => void;
      onAccessibilityMissing?: (callback: () => void) => () => void;
      checkAccessibilityTrusted?: () => Promise<boolean>;

      // Custom endpoint API keys
      getCustomTranscriptionKey?: () => Promise<string | null>;
      saveCustomTranscriptionKey?: (key: string) => Promise<void>;
      getCleanupCustomKey?: () => Promise<string | null>;
      saveCleanupCustomKey?: (key: string) => Promise<void>;
      getNoteFormattingCustomKey?: () => Promise<string | null>;
      saveNoteFormattingCustomKey?: (key: string) => Promise<void>;
      getTranslationCustomKey?: () => Promise<string | null>;
      saveTranslationCustomKey?: (key: string) => Promise<void>;
      getDictationAgentCustomKey?: () => Promise<string | null>;
      saveDictationAgentCustomKey?: (key: string) => Promise<void>;
      getDictationAgentVisionCustomKey?: () => Promise<string | null>;
      saveDictationAgentVisionCustomKey?: (key: string) => Promise<void>;
      getChatAgentCustomKey?: () => Promise<string | null>;
      saveChatAgentCustomKey?: (key: string) => Promise<void>;

      // Dictation key persistence (file-based for reliable startup)
      getDictationKey?: () => Promise<string | null>;
      getActiveDictationKey?: () => Promise<string>;
      getEffectiveDefaultHotkey?: () => Promise<string>;
      saveDictationKey?: (key: string) => Promise<void>;

      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;
      saveActivationMode?: (mode: "tap" | "push") => Promise<void>;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getDebugState: () => Promise<{
        enabled: boolean;
        logPath: string | null;
        logLevel: string;
      }>;
      setDebugLogging: (enabled: boolean) => Promise<{
        success: boolean;
        enabled?: boolean;
        logPath?: string | null;
        error?: string;
      }>;
      openLogsFolder: () => Promise<{ success: boolean; error?: string }>;

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      getAudioDiagnostics: () => Promise<AudioDiagnosticsResult>;

      // System settings helpers
      requestMicrophoneAccess?: () => Promise<{ granted: boolean }>;
      checkMicrophoneAccess?: () => Promise<{ granted: boolean; status: string }>;
      getSystemDefaultMicrophone?: (options?: { refresh?: boolean }) => Promise<{
        name: string;
        nativeId?: string;
        platform: string;
        source: "system" | "unavailable";
      }>;
      checkSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      requestSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      openSystemAudioSettings?: () => Promise<{ success: boolean; error?: string }>;
      openScreenRecordingSettings?: () => Promise<{ success: boolean; error?: string }>;
      openLoginItemsSettings?: () => Promise<{ success: boolean; error?: string }>;
      checkScreenRecordingAccess?: () => Promise<ScreenRecordingAccessResult>;
      requestScreenRecordingAccess?: () => Promise<ScreenRecordingAccessResult>;
      captureScreenContext?: () => Promise<ScreenContextImage | null>;
      setScreenContextEnabled?: (enabled: boolean) => Promise<{ success: boolean }>;
      toggleMediaPlayback?: () => Promise<boolean>;
      pauseMediaPlayback?: () => Promise<boolean>;
      resumeMediaPlayback?: () => Promise<boolean>;
      getModelCacheRoot?: () => Promise<string>;
      openWhisperModelsFolder?: () => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      registerMeetingHotkey?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
      notifyFloatingIconAutoHideChanged?: (enabled: boolean) => void;
      onFloatingIconAutoHideChanged?: (callback: (enabled: boolean) => void) => () => void;
      notifyStartMinimizedChanged?: (enabled: boolean) => void;
      notifyPanelStartPositionChanged?: (position: string) => void;
      getMainWindowHorizontalDirection?: () => Promise<"left" | "right">;
      onMainWindowHorizontalDirectionChanged?: (
        callback: (direction: "left" | "right") => void
      ) => () => void;
      onMainWindowWillResize?: (
        callback: (resize: {
          bounds: Electron.Rectangle;
          anchor: "bottom-left" | "bottom-right" | "center";
        }) => void
      ) => () => void;

      // Auto-start at login. requiresApproval is macOS-only: SMAppService can
      // register the login item and still leave it awaiting approval in System
      // Settings, which otherwise looks like a toggle that will not stick.
      getAutoStartEnabled?: () => Promise<{ enabled: boolean; requiresApproval: boolean }>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      cancelUploadTranscription?: (requestId: string) => Promise<{ success: boolean }>;

      // BYOK audio file transcription
      transcribeAudioFileSelfHosted?: (options: {
        filePath: string;
        language?: string;
        transcriptionMode?: string;
        remoteTranscriptionUrl?: string;
        remoteTranscriptionModel?: string;
        requestId?: string;
      }) => Promise<{
        success: boolean;
        text?: string;
        error?: string;
        code?: string;
        messageKey?: string;
      }>;

      // Agent Mode
      updateVoiceAgentHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      getVoiceAgentKey?: () => Promise<string>;
      updateTranslationHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      getTranslationKey?: () => Promise<string>;
      createAgentConversation?: (
        title: string,
        noteId?: number | null,
        spaceId?: number | null,
        folderId?: number | null
      ) => Promise<{
        id: number;
        title: string;
        note_id?: number | null;
        space_id?: number | null;
        folder_id?: number | null;
        created_at: string;
        updated_at: string;
      } | null>;
      getConversationsForNote?: (
        noteId: number,
        limit?: number
      ) => Promise<
        Array<{
          id: number;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }>
      >;
      getConversationsForContainer?: (
        spaceId: number,
        folderId?: number | null,
        limit?: number
      ) => Promise<
        Array<{
          id: number;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }>
      >;
      getAgentConversations?: (limit?: number) => Promise<
        Array<{
          id: number;
          title: string;
          archived_at?: string;
          client_conversation_id?: string;
          created_at: string;
          updated_at: string;
        }>
      >;
      getAgentConversation?: (id: number) => Promise<{
        id: number;
        title: string;
        archived_at?: string;
        client_conversation_id?: string | null;
        created_at: string;
        updated_at: string;
        messages: Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>;
      } | null>;
      deleteAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationTitle?: (id: number, title: string) => Promise<{ success: boolean }>;
      addAgentMessage?: (
        conversationId: number,
        role: "user" | "assistant" | "system",
        content: string,
        metadata?: Record<string, unknown>
      ) => Promise<{
        id: number;
        conversation_id: number;
        role: string;
        content: string;
        metadata?: string;
        created_at: string;
      } | null>;
      getAgentMessages?: (conversationId: number) => Promise<
        Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>
      >;
      getAgentConversationsWithPreview?: (
        limit?: number,
        offset?: number,
        includeArchived?: boolean
      ) => Promise<ConversationPreview[]>;
      searchAgentConversations?: (query: string, limit?: number) => Promise<ConversationPreview[]>;
      archiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      unarchiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      semanticSearchConversations?: (
        query: string,
        limit?: number
      ) => Promise<ConversationPreview[]>;

      // Agent tools
      agentOpenNote?: (noteId: number) => Promise<{ success: boolean; error?: string }>;
      agentWebSearch?: (
        query: string,
        numResults?: number,
        options?: { baseUrl: string; timeRange?: "day" | "week" | "month" | "year" }
      ) => Promise<{
        success: boolean;
        results?: Array<{
          title: string;
          url: string;
          text: string;
          publishedDate: string | null;
        }>;
        answers?: string[];
        infobox?: { title: string; text: string; url: string | null };
        error?: string;
        errorCode?: string;
      }>;

      // Calendar events (shared cache)
      calendarGetUpcomingEvents?: (
        windowMinutes?: number
      ) => Promise<{ success: boolean; events: any[] }>;
      calendarGetAvailability?: (
        request: CalendarAvailabilityRequest
      ) => Promise<
        | { success: true; availability: CalendarAvailabilityResult }
        | { success: false; error: string }
      >;
      calendarGetEvent?: (eventId: string) => Promise<{
        success: boolean;
        event: {
          id: string;
          summary: string | null;
          start_time: string;
          end_time: string;
          attendees_count: number;
          attendees: string | null;
        } | null;
      }>;

      // Contacts
      searchContacts: (query: string) => Promise<{
        success: boolean;
        contacts: Array<{ email: string; display_name: string | null }>;
      }>;
      upsertContact: (contact: {
        email: string;
        displayName?: string | null;
      }) => Promise<{ success: boolean }>;
      getMD5Hash: (text: string) => Promise<string>;

      meetingTranscriptionStart?: (options: {
        provider?: string;
        localProvider?: string;
        localModel?: string;
        remoteTranscriptionUrl?: string;
        remoteTranscriptionModel?: string;
        language?: string;
        noteId?: number | null;
        sessionId: string;
        autoEndEligible: boolean;
      }) => Promise<{
        success: boolean;
        sessionId?: string;
        error?: string;
        systemAudioMode?: SystemAudioMode;
        systemAudioStrategy?: SystemAudioStrategy;
        oneOnOneAttendee?: { displayName: string; email: string | null } | null;
        code?: string;
      }>;
      meetingTranscriptionSend?: (buffer: ArrayBuffer, source: "mic" | "system") => void;
      meetingTranscriptionSetSystemAudioAvailable?: (
        sessionId: string,
        available: boolean
      ) => Promise<{ success: boolean; reason?: "stale-session" }>;
      meetingTranscriptionStop?: (expectedSessionId?: string) => Promise<{
        success: boolean;
        transcript?: string;
        diarizationSessionId?: string;
        error?: string;
        reason?: "stale-session";
      }>;
      onMeetingTranscriptionSegment?: (
        callback: (data: {
          text: string;
          source: "mic" | "system";
          type: "partial" | "final" | "retract";
          timestamp?: number;
        }) => void
      ) => () => void;
      onMeetingSpeakerIdentified?: (
        callback: (data: {
          speakerId: string;
          displayName?: string | null;
          startTime: number;
          endTime: number;
        }) => void
      ) => () => void;
      onMeetingSpeakersMerged?: (
        callback: (
          merges: Array<{
            keep: string;
            remove: string;
            displayName?: string | null;
            similarity: number;
          }>
        ) => void
      ) => () => void;
      onMeetingSessionSpeakerConfigUpdated?: (
        callback: (config: { enabled: boolean; expectedCount: number }) => void
      ) => () => void;
      onMeetingTranscriptionError?: (callback: (error: string) => void) => () => void;
      onMeetingSystemAudioSilent?: (
        callback: (data: { systemAudioStrategy: SystemAudioStrategy }) => void
      ) => () => void;
      onMeetingSystemAudioDegraded?: (callback: () => void) => () => void;
      onMeetingSystemAudioInterrupted?: (
        callback: (data: MeetingSystemAudioInterruption) => void
      ) => () => void;
      onMeetingSystemAudioResumed?: (callback: () => void) => () => void;

      // Speaker diarization
      downloadDiarizationModels?: () => Promise<{ success: boolean; error?: string }>;
      getDiarizationModelStatus?: () => Promise<{
        available: boolean;
        modelsDownloaded: boolean;
      }>;
      deleteDiarizationModels?: () => Promise<{ success: boolean }>;
      cancelDiarizationDownload?: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      mergeSpeakerText?: (
        segments: Array<{ start: number; end: number; speaker: string }>,
        text: string,
        duration: number,
        textSegments?: Array<{ text: string; start: number; end: number }>
      ) => Promise<{
        success: boolean;
        text?: string;
        segments?: Array<{ text: string; start: number; end: number; speaker: string }>;
        error?: string;
      }>;
      diarizeAudioFile?: (
        filePath: string,
        options?: { numSpeakers?: number; threshold?: number; requestId?: string }
      ) => Promise<{
        success: boolean;
        segments?: Array<{ start: number; end: number; speaker: string }>;
        durationSeconds?: number;
        error?: string;
        code?: string;
      }>;
      onDiarizationDownloadProgress?: (callback: (data: any) => void) => () => void;
      onMeetingDiarizationComplete?: (
        callback: (data: {
          sessionId?: string;
          noteId?: number | null;
          segments: Array<{
            id: string;
            text: string;
            source: "mic" | "system";
            timestamp?: number;
            speaker?: string;
            speakerName?: string;
            speakerIsPlaceholder?: boolean;
            suggestedName?: string;
            suggestedProfileId?: number;
            speakerStatus?: "provisional" | "confirmed" | "suggested" | "locked";
            speakerLocked?: boolean;
            speakerLockSource?: "user" | "diarization" | "suggestion";
          }>;
          speakerEmbeddings?: Record<string, number[]> | null;
        }) => void
      ) => () => void;

      // Speaker name mapping
      getSpeakerMappings?: (noteId: number) => Promise<
        Array<{
          note_id: number;
          speaker_id: string;
          profile_id: number | null;
          display_name: string;
        }>
      >;
      setSpeakerMapping?: (
        noteId: number,
        speakerId: string,
        displayName: string,
        email?: string | null,
        profileId?: number | null
      ) => Promise<{ success: boolean; profileId: number | null }>;
      removeSpeakerMapping?: (noteId: number, speakerId: string) => Promise<{ success: boolean }>;
      getSpeakerProfiles?: () => Promise<
        Array<{
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
          created_at: string;
          updated_at: string;
        }>
      >;
      attachSpeakerEmail?: (
        profileId: number,
        email: string | null
      ) => Promise<{
        success: boolean;
        error?: string;
        profile?: {
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
        };
      }>;
      saveNoteSpeakerEmbeddings?: (
        noteId: number,
        embeddings: Record<string, number[]>
      ) => Promise<{ success: boolean }>;

      // Apple Calendar (macOS EventKit)
      acalConnect?: () => Promise<{ success: boolean; reason?: string; error?: string }>;
      acalDisconnect?: () => Promise<{ success: boolean; error?: string }>;
      acalGetConnectionStatus?: () => Promise<{ connected: boolean; sourceNames: string[] }>;
      openCalendarPrivacySettings?: () => Promise<{ success: boolean; error?: string }>;
      onAcalConnectionChanged?: (
        callback: (data: { connected: boolean; sourceNames: string[] }) => void
      ) => () => void;
      onAcalEventsSynced?: (callback: (data: any) => void) => () => void;

      syncNotificationPreferences?: (prefs: {
        notificationsEnabled: boolean;
        notifyMeetingDetection: boolean;
        notifyCalendarReminders: boolean;
        meetingProcessDetection: boolean;
      }) => Promise<{ success: boolean }>;
      setSpeakerDiarizationEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      setMeetingSessionSpeakerConfig?: (config: {
        enabled: boolean;
        expectedCount: number;
        countIsExplicit?: boolean;
      }) => Promise<{ success: boolean; error?: string }>;
      getWhisperVadConfig?: () => Promise<{
        success: boolean;
        config?: {
          dictationSileroEnabled: boolean;
          noteRecordingSileroEnabled: boolean;
          meetingSileroEnabled: boolean;
          threshold: number;
          minSpeechDurationMs: number;
          minSilenceDurationMs: number;
          maxSpeechDurationS: number;
          speechPadMs: number;
          samplesOverlap: number;
        };
        error?: string;
      }>;
      setWhisperVadConfig?: (config: {
        dictationSileroEnabled?: boolean;
        noteRecordingSileroEnabled?: boolean;
        meetingSileroEnabled?: boolean;
        threshold?: number;
        minSpeechDurationMs?: number;
        minSilenceDurationMs?: number;
        maxSpeechDurationS?: number;
        speechPadMs?: number;
        samplesOverlap?: number;
      }) => Promise<{ success: boolean; config?: Record<string, unknown>; error?: string }>;
      onMeetingNotificationData?: (callback: (data: MeetingNotificationData) => void) => () => void;
      onMeetingAutoEndRequested?: (
        callback: (request: MeetingAutoEndRequest) => void
      ) => () => void;
      getMeetingNotificationData?: () => Promise<MeetingNotificationData | null>;
      meetingNotificationReady?: () => Promise<void>;
      meetingNotificationRespond?: (
        detectionId: string,
        action: string
      ) => Promise<{ success: boolean }>;
      joinCalendarMeeting?: (eventId: string) => Promise<{ success: boolean }>;
      startManualMeeting?: () => Promise<void>;
      getPendingMeetingNoteNavigation?: () => Promise<{
        noteId: number;
        folderId: number;
        event: any;
        trigger?: "hotkey" | "manual" | "calendar-join";
      } | null>;
      onMeetingNoteNavigationPending?: (callback: () => void) => () => void;
      getPendingNoteNavigation?: () => Promise<{
        noteId: number;
        folderId: number | null;
      } | null>;
      onNoteNavigationPending?: (callback: () => void) => () => void;
      onPreviewText?: (callback: (text: string) => void) => () => void;
      onPreviewAppend?: (callback: (text: string) => void) => () => void;
      onPreviewHold?: (callback: (payload: { showCleanup: boolean }) => void) => () => void;
      onPreviewResult?: (callback: (payload: { text: string }) => void) => () => void;
      onPreviewHide?: (callback: () => void) => () => void;
      startDictationPreview?: (opts: {
        provider: string;
        model: string;
        language?: string;
        display?: boolean;
      }) => Promise<{ success: boolean }>;
      stopDictationPreview?: (opts?: {
        showCleanup?: boolean;
        flushed?: boolean;
      }) => Promise<{ success: boolean; streamed?: boolean; text?: string }>;
      dismissDictationPreview?: () => Promise<{ success: boolean }>;
      completeDictationPreview?: (payload: { text?: string }) => Promise<{ success: boolean }>;
      hideDictationPreview?: () => Promise<{ success: boolean }>;
      sendDictationPreviewAudio?: (data: ArrayBuffer) => void;
    };

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
