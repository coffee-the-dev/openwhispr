// Where speaker diarization runs for meetings and uploads: the on-device
// sherpa-onnx diarizer, or the user's own server answering
// POST {base}/audio/diarizations (the NeMo-Speech.cpp contract).
//
// Self-hosted fails closed like transcription: a missing or unsupported URL is
// an error, never a silent switch to the local diarizer.
//
// Loaded by the main process via dynamic import: erasable TypeScript syntax
// only, explicit import extensions, no store imports.
import { buildApiUrl, normalizeBaseUrl } from "../config/constants.ts";
import { isSecureHttpEndpoint } from "../utils/urlUtils.ts";

export interface DiarizationRouteSettings {
  mode?: string;
  url?: string;
}

export type DiarizationRoute =
  | { transport: "local" }
  | { transport: "http"; endpoint: string }
  | { transport: "error"; message: string };

export function resolveDiarizationRoute(settings: DiarizationRouteSettings): DiarizationRoute {
  if (settings?.mode !== "self-hosted") return { transport: "local" };

  const base = normalizeBaseUrl((settings.url || "").trim());
  if (!base) {
    return { transport: "error", message: "Self-hosted speaker detection URL is not configured" };
  }
  if (!isSecureHttpEndpoint(base)) {
    return {
      transport: "error",
      message: "Self-hosted speaker detection URL is invalid or unsupported",
    };
  }
  return { transport: "http", endpoint: buildApiUrl(base, "/audio/diarizations") };
}
