import { resolveTranscriptionRoute, type TranscriptionRoute } from "../helpers/transcriptionRoute";
import type { LocalTranscriptionProvider } from "../types/electron";

export interface FileTranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
  code?: string;
  messageKey?: string;
  // The transcript succeeded, but requested speaker labels could not be applied.
  diarizationWarning?: boolean;
  warning?: string;
  // Measured duration of the source audio, for persisting as
  // audio_duration_seconds. Only transcribeFileWithSpeakers sets it.
  durationSeconds?: number | null;
  // Segment-level timing when the engine returned it; absent for text-only results.
  segments?: Array<{ text: string; start: number; end: number; speaker?: string }>;
}

export interface DiarizationSettings {
  enabled: boolean;
  // Local sherpa-onnx diarization models are present.
  localModelsReady: boolean;
  numSpeakers: number | null;
}

export interface FileTranscriptionConfig {
  useLocalWhisper: boolean;
  localTranscriptionProvider: string;
  whisperModel: string;
  parakeetModel: string;
  cohereModel: string;
  language: string;
  transcriptionMode?: string;
  remoteTranscriptionUrl?: string;
  remoteTranscriptionModel?: string;
}

// Pre-flight through the shared resolver: code-carrying errors surface here
// without an IPC round-trip; the main-process handler re-resolves the same
// fields as defense in depth.
export function resolveFileTranscriptionRoute(cfg: FileTranscriptionConfig): TranscriptionRoute {
  return resolveTranscriptionRoute({
    settings: {
      transcriptionMode: cfg.transcriptionMode,
      remoteTranscriptionUrl: cfg.remoteTranscriptionUrl,
      remoteTranscriptionModel: cfg.remoteTranscriptionModel,
    },
    request: { effectiveLanguage: cfg.language || undefined },
  });
}

// Single dispatch shared by the single-file flow and the batch queue, so both
// send identical options.
export async function transcribeFile(
  filePath: string,
  cfg: FileTranscriptionConfig,
  opts: { requestId?: string } = {}
): Promise<FileTranscriptionResult> {
  if (cfg.useLocalWhisper) {
    const provider = cfg.localTranscriptionProvider as LocalTranscriptionProvider;
    return window.electronAPI.transcribeAudioFile(filePath, {
      provider,
      model:
        provider === "nvidia"
          ? cfg.parakeetModel
          : provider === "cohere"
            ? cfg.cohereModel
            : cfg.whisperModel,
      // Only Cohere consumes it (no auto-detect); passing it to whisper would
      // override its auto language detection.
      ...(provider === "cohere" && cfg.language ? { language: cfg.language } : {}),
      requestId: opts.requestId,
    });
  }

  const route = resolveFileTranscriptionRoute(cfg);
  if (route.transport === "error") {
    return {
      success: false,
      error: route.message,
      code: route.code,
      messageKey: route.messageKey,
    };
  }

  return window.electronAPI.transcribeAudioFileSelfHosted!({
    filePath,
    language: cfg.language,
    transcriptionMode: cfg.transcriptionMode,
    remoteTranscriptionUrl: cfg.remoteTranscriptionUrl,
    remoteTranscriptionModel: cfg.remoteTranscriptionModel,
    requestId: opts.requestId,
  });
}

interface DiarizationSettingsRequest {
  enabled: boolean;
  modelsReady: boolean;
  numSpeakers: number | null;
  ensureModels: () => Promise<boolean>;
}

// Speaker detection is opt-in but its local models download lazily, so a run
// started before they land would report "couldn't be applied" without the
// diarizer ever being invoked. Fetch them first.
export async function resolveDiarizationSettings({
  enabled,
  modelsReady,
  numSpeakers,
  ensureModels,
}: DiarizationSettingsRequest): Promise<DiarizationSettings> {
  const needsLocalModels = enabled && !modelsReady;
  return {
    enabled,
    localModelsReady: needsLocalModels ? await ensureModels() : modelsReady,
    numSpeakers,
  };
}

// Transcribe and diarize in parallel, then merge speaker labels into the text.
// Diarization always runs locally, including over self-hosted transcripts.
// Shared by the single-file flow and the batch queue. `durationSeconds` (when the
// source knows it, e.g. URL downloads) beats inferring duration from segments.
export async function transcribeFileWithSpeakers(
  filePath: string,
  cfg: FileTranscriptionConfig,
  diarization: DiarizationSettings,
  durationSeconds?: number | null,
  opts: { requestId?: string } = {}
): Promise<FileTranscriptionResult> {
  const diarizePromise =
    diarization.enabled && diarization.localModelsReady
      ? (window.electronAPI
          .diarizeAudioFile?.(filePath, {
            numSpeakers: diarization.numSpeakers ?? undefined,
            requestId: opts.requestId,
          })
          .catch(() => null) ?? Promise.resolve(null))
      : Promise.resolve(null);

  const [transcribed, diar] = await Promise.all([
    transcribeFile(filePath, cfg, opts),
    diarizePromise,
  ]);

  // The diarizer measures the converted audio, so it covers picked files whose
  // duration the caller never knew. 0/NaN mean "unknown", hence ||.
  const measuredDuration = durationSeconds || (diar?.success && diar.durationSeconds) || null;
  const result = { ...transcribed, durationSeconds: measuredDuration };

  if (!result.success || !result.text || !diarization.enabled) return result;
  if (!diar?.success || !diar.segments?.length) {
    return { ...result, diarizationWarning: true };
  }

  try {
    // Timed segments from the transcription server align speakers by time.
    const merged = await window.electronAPI.mergeSpeakerText?.(
      diar.segments,
      result.text,
      durationSeconds || 0,
      result.segments?.length ? result.segments : undefined
    );
    if (merged?.success && merged.text) {
      return {
        ...result,
        text: merged.text,
        ...(merged.segments?.length ? { segments: merged.segments } : {}),
      };
    }
  } catch {
    // Merge failure falls back to the plain transcript.
  }
  return { ...result, diarizationWarning: true };
}
