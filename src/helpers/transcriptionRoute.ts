// Single source of truth for batch speech-to-text routing across dictation,
// retry, and upload. Callers resolve their scope's settings into the flat base
// names. Transcription runs on-device or against the user's own self-hosted
// OpenAI-compatible server; nothing else is routable.
//
// Loaded by the renderer and the main process alike (main uses dynamic import):
// erasable TypeScript syntax only, explicit import extensions, no store imports.
import { buildApiUrl, normalizeBaseUrl } from "../config/constants.ts";
import { isSecureHttpEndpoint } from "../utils/urlUtils.ts";
import {
  isSelfHostedTranscription,
  resolveSelfHostedTranscriptionModel,
} from "./selfHostedTranscription.js";

export interface TranscriptionRouteSettings {
  transcriptionMode?: string;
  remoteTranscriptionUrl?: string;
  remoteTranscriptionModel?: string;
  preferredLanguage?: string;
}

export interface TranscriptionRouteInput {
  /** Scope-resolved snapshot — the resolver never re-maps selections. */
  settings: TranscriptionRouteSettings;
  request?: {
    /** Translation-aware language (dictation's getEffectiveSttLanguage) — wins over preferredLanguage. */
    effectiveLanguage?: string;
  };
}

export type TranscriptionRoute =
  | { transport: "error"; message: string; code?: string; messageKey?: string }
  | { transport: "local" }
  | {
      transport: "http-batch";
      endpoint: string;
      model: string | null;
      language?: string;
    };

const SELF_HOSTED_NOT_CONFIGURED_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.selfHostedNotConfigured";

function notConfigured(message: string): TranscriptionRoute {
  return {
    transport: "error",
    message,
    code: "SELF_HOSTED_NOT_CONFIGURED",
    messageKey: SELF_HOSTED_NOT_CONFIGURED_MESSAGE_KEY,
  };
}

export function resolveTranscriptionRoute({
  settings,
  request,
}: TranscriptionRouteInput): TranscriptionRoute {
  const s = settings || {};
  const language =
    request?.effectiveLanguage ??
    (!s.preferredLanguage || s.preferredLanguage === "auto"
      ? undefined
      : s.preferredLanguage.split("-")[0]);

  // Self-hosted wins over everything, including stale useLocalWhisper flags.
  if (s.transcriptionMode === "self-hosted") {
    if (!isSelfHostedTranscription(s)) {
      return notConfigured("Self-hosted transcription URL is not configured");
    }
    const base = normalizeBaseUrl((s.remoteTranscriptionUrl || "").trim());
    if (!base || !isSecureHttpEndpoint(base)) {
      return notConfigured("Self-hosted transcription URL is invalid or unsupported");
    }
    return {
      transport: "http-batch",
      endpoint: buildApiUrl(base, "/audio/transcriptions"),
      model: resolveSelfHostedTranscriptionModel(s),
      language,
    };
  }

  // Engine and model selection stay with the local managers.
  return { transport: "local" };
}
