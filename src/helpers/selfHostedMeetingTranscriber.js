// Note Recording over a self-hosted OpenAI-compatible speech-to-text server.
//
// The meeting closure in ipcHandlers.js cuts each source (mic, system) into
// ~5 s PCM batches and sends them one request at a time — system, then mic —
// so a server that decodes one sequence at a time (vLLM max-num-seqs 1) never
// sees concurrent requests. Queue policy, per source:
//   * While a request is in flight, new audio keeps accumulating in that
//     source's buffer and goes out merged into the next request, so a slow
//     server means fewer, longer requests rather than a growing request queue.
//   * The merged batch is capped at MEETING_REMOTE_MAX_BACKLOG_MS. Older audio
//     beyond the cap is dropped (and reported once), so latency stays bounded
//     when the server cannot keep up with real time.
//   * A transient failure (network, timeout, 408/425/429/5xx) is retried once;
//     anything else, or a second failure, drops that batch and the recording
//     carries on.

const MEETING_PCM_SAMPLE_RATE = 24000;
const MEETING_PCM_BYTES_PER_SAMPLE = 2;
const MEETING_REMOTE_MAX_BACKLOG_MS = 30_000;
const MEETING_REMOTE_MAX_BACKLOG_BYTES =
  (MEETING_REMOTE_MAX_BACKLOG_MS / 1000) * MEETING_PCM_SAMPLE_RATE * MEETING_PCM_BYTES_PER_SAMPLE;
const MEETING_REMOTE_REQUEST_TIMEOUT_MS = 30_000;
const MEETING_REMOTE_RETRY_DELAY_MS = 500;

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

// Keeps the newest audio within maxBytes. A chunk straddling the cut keeps its
// tail, trimmed to a whole sample so the PCM stays aligned.
function capMeetingBacklog(chunks, maxBytes = MEETING_REMOTE_MAX_BACKLOG_BYTES) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  if (total <= maxBytes) return { chunks, droppedBytes: 0 };

  const kept = [];
  let keptBytes = 0;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    const room = maxBytes - keptBytes;
    if (room <= 0) break;
    if (chunk.length <= room) {
      kept.unshift(chunk);
      keptBytes += chunk.length;
      continue;
    }
    const tail = room - (room % MEETING_PCM_BYTES_PER_SAMPLE);
    if (tail > 0) {
      kept.unshift(chunk.subarray(chunk.length - tail));
      keptBytes += tail;
    }
    break;
  }
  return { chunks: kept, droppedBytes: total - keptBytes };
}

function isTransientTranscriptionFailure(error) {
  if (!error) return false;
  if (typeof error.status === "number") return TRANSIENT_STATUSES.has(error.status);
  // No HTTP status: the request never completed (network error or timeout).
  return true;
}

function httpFailure(status, detail) {
  return Object.assign(
    new Error(`Self-hosted transcription failed (${status})${detail ? `: ${detail}` : ""}`),
    { status }
  );
}

function createSelfHostedChunkTranscriber({
  endpoint,
  model,
  language,
  getHeaders = () => ({}),
  fetchImpl = fetch,
  timeoutMs = MEETING_REMOTE_REQUEST_TIMEOUT_MS,
  retryDelayMs = MEETING_REMOTE_RETRY_DELAY_MS,
}) {
  const requestOnce = async (wavBuffer) => {
    const form = new FormData();
    form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "meeting-chunk.wav");
    if (model) form.append("model", model);
    if (language) form.append("language", language);
    form.append("response_format", "json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { ...getHeaders() },
        body: form,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) throw httpFailure(response.status, body.slice(0, 200));
      let text = body;
      try {
        const data = JSON.parse(body);
        text = typeof data?.text === "string" ? data.text : "";
      } catch {
        // Some servers answer json requests with the bare transcript.
      }
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async transcribe(wavBuffer) {
      try {
        return { success: true, text: await requestOnce(wavBuffer) };
      } catch (error) {
        if (!isTransientTranscriptionFailure(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        return { success: true, text: await requestOnce(wavBuffer) };
      }
    },
  };
}

module.exports = {
  MEETING_REMOTE_MAX_BACKLOG_BYTES,
  MEETING_REMOTE_MAX_BACKLOG_MS,
  capMeetingBacklog,
  createSelfHostedChunkTranscriber,
  isTransientTranscriptionFailure,
};
