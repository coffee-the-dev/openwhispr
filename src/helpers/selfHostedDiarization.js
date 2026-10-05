// Speaker diarization on the user's own server (NeMo-Speech.cpp contract):
// POST {base}/audio/diarizations with a WAV in `file` and `mode`, answered by
// {"segments": [{"start": s, "end": s, "speaker": n}]}.
//
// Server speaker ids are relabelled to the local diarizer's "speaker_N" form in
// order of first appearance, so cluster capping, transcript merging and
// on-device speaker-profile naming treat both diarizers the same.

const {
  computeTranscriptionTimeoutMs,
  PCM16_MONO_16K_BYTES_PER_SECOND,
} = require("./transcriptionTimeout");

const WAV_HEADER_BYTES = 44;
// Upstream: full-attention `offline` covers recordings up to about 6.6 minutes;
// `streaming` is the long-form path. Six minutes leaves headroom.
const OFFLINE_MODE_MAX_SECONDS = 360;

class DiarizationServerError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "DiarizationServerError";
    this.statusCode = statusCode;
  }
}

function resolveServerDiarizationMode(durationSeconds) {
  return Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    durationSeconds <= OFFLINE_MODE_MAX_SECONDS
    ? "offline"
    : "streaming";
}

function normalizeServerSegments(data) {
  const raw = Array.isArray(data?.segments) ? data.segments : [];
  const valid = [];
  for (const segment of raw) {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const speaker = segment?.speaker;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    if (speaker == null || speaker === "") continue;
    valid.push({ start, end, speaker: String(speaker) });
  }
  valid.sort((a, b) => a.start - b.start);

  const labels = new Map();
  return valid.map((segment) => {
    if (!labels.has(segment.speaker)) labels.set(segment.speaker, `speaker_${labels.size}`);
    return { start: segment.start, end: segment.end, speaker: labels.get(segment.speaker) };
  });
}

function serverErrorMessage(statusCode, data) {
  if (statusCode === 401 || statusCode === 403) {
    return "Speaker detection server rejected the API key.";
  }
  const detail = data?.error?.message || (typeof data?.error === "string" ? data.error : null);
  return detail || `Speaker detection server error ${statusCode}`;
}

// `post(fields, signal)` sends one multipart request carrying the WAV and
// resolves { statusCode, data }. `wavBuffer` is 16 kHz mono PCM16, which both
// callers produce, so its length gives the duration.
async function diarizeViaServer({ wavBuffer, post, signal = null }) {
  const durationSeconds =
    Math.max(0, wavBuffer.length - WAV_HEADER_BYTES) / PCM16_MONO_16K_BYTES_PER_SECOND;
  const mode = resolveServerDiarizationMode(durationSeconds);
  const timeout = AbortSignal.timeout(computeTranscriptionTimeoutMs(durationSeconds));
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const { statusCode, data } = await post({ mode }, requestSignal);
  if (statusCode !== 200) {
    throw new DiarizationServerError(serverErrorMessage(statusCode, data), statusCode);
  }
  return { segments: normalizeServerSegments(data), mode, durationSeconds };
}

module.exports = {
  OFFLINE_MODE_MAX_SECONDS,
  DiarizationServerError,
  diarizeViaServer,
  normalizeServerSegments,
  resolveServerDiarizationMode,
};
