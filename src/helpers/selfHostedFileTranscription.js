// Upload transcription against a self-hosted OpenAI-compatible server.
//
// Timed segments let local diarization put speakers on the right sentences, so
// each request first asks for `verbose_json` with segment timestamps. A server
// that rejects that format (a 4xx other than auth, size or rate limits) is
// asked again for plain `json`; one that accepts it but returns no segments
// keeps its text. Either way the endpoint is remembered for the session and
// later uploads go straight to `json`.
//
// Files over the server's upload cap are split (ffmpeg) into fixed-length
// chunks; each chunk's segments are shifted by its start offset and stitched.

const SELF_HOSTED_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const SELF_HOSTED_CHUNK_SECONDS = 600;

const verboseUnsupportedEndpoints = new Set();

// Statuses that mean "not this request format", as opposed to credentials,
// payload size or load — those would fail the json retry the same way.
function rejectsResponseFormat(status) {
  return status >= 400 && status < 500 && ![401, 403, 408, 413, 429].includes(status);
}

function mapVerboseSegments(data, offsetSeconds = 0) {
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  return segments
    .map((segment) => {
      const text = typeof segment?.text === "string" ? segment.text.trim() : "";
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      if (!text || !Number.isFinite(start)) return null;
      return {
        text,
        start: start + offsetSeconds,
        end: (Number.isFinite(end) && end >= start ? end : start) + offsetSeconds,
      };
    })
    .filter(Boolean);
}

function responseText(data) {
  return typeof data?.text === "string" ? data.text.trim() : "";
}

// `post(fields)` sends one multipart request and resolves { statusCode, data }.
async function requestTranscription({ post, endpoint, model, offsetSeconds = 0 }) {
  const base = model ? { model } : {};
  if (!verboseUnsupportedEndpoints.has(endpoint)) {
    const verbose = await post({
      ...base,
      response_format: "verbose_json",
      "timestamp_granularities[]": "segment",
    });
    if (verbose.statusCode === 200) {
      const segments = mapVerboseSegments(verbose.data, offsetSeconds);
      if (segments.length === 0) verboseUnsupportedEndpoints.add(endpoint);
      return {
        statusCode: 200,
        data: verbose.data,
        text: responseText(verbose.data) || segments.map((s) => s.text).join(" "),
        segments: segments.length > 0 ? segments : null,
      };
    }
    if (!rejectsResponseFormat(verbose.statusCode)) return { ...verbose, segments: null };
    verboseUnsupportedEndpoints.add(endpoint);
  }

  const plain = await post({ ...base, response_format: "json" });
  return {
    ...plain,
    text: plain.statusCode === 200 ? responseText(plain.data) : "",
    segments: null,
  };
}

// Segments survive only when every chunk had them: a gap would misplace every
// speaker after it.
function stitchTranscriptionChunks(parts) {
  const text = parts
    .map((part) => part.text)
    .filter(Boolean)
    .join(" ")
    .trim();
  const segments = parts.every((part) => Array.isArray(part.segments) && part.segments.length)
    ? parts.flatMap((part) => part.segments)
    : null;
  return { text, segments };
}

function resetResponseFormatCache() {
  verboseUnsupportedEndpoints.clear();
}

module.exports = {
  SELF_HOSTED_CHUNK_SECONDS,
  SELF_HOSTED_UPLOAD_LIMIT_BYTES,
  mapVerboseSegments,
  rejectsResponseFormat,
  requestTranscription,
  resetResponseFormatCache,
  stitchTranscriptionChunks,
};
