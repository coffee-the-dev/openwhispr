const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OFFLINE_MODE_MAX_SECONDS,
  DiarizationServerError,
  diarizeViaServer,
  normalizeServerSegments,
} = require("../../src/helpers/selfHostedDiarization");

const BYTES_PER_SECOND = 16000 * 2;
const wavOfSeconds = (seconds) => Buffer.alloc(44 + Math.round(seconds * BYTES_PER_SECOND));

test("relabels 1-based server speakers to speaker_N in order of first appearance", () => {
  const segments = normalizeServerSegments({
    segments: [
      { start: 4, end: 6, speaker: 1 },
      { start: 0, end: 2, speaker: 3 },
      { start: 2, end: 4, speaker: 1 },
      { start: 6, end: 7, speaker: 3 },
    ],
  });
  assert.deepEqual(segments, [
    { start: 0, end: 2, speaker: "speaker_0" },
    { start: 2, end: 4, speaker: "speaker_1" },
    { start: 4, end: 6, speaker: "speaker_1" },
    { start: 6, end: 7, speaker: "speaker_0" },
  ]);
});

test("drops segments without a usable time span or speaker", () => {
  const segments = normalizeServerSegments({
    segments: [
      { start: 1, end: 1, speaker: 1 },
      { start: 3, end: 2, speaker: 1 },
      { start: -1, end: 2, speaker: 1 },
      { start: "x", end: 2, speaker: 1 },
      { start: 0, end: 2 },
      { start: 0, end: 2, speaker: "" },
      { start: "5", end: "6.5", speaker: "2" },
    ],
  });
  assert.deepEqual(segments, [{ start: 5, end: 6.5, speaker: "speaker_0" }]);
  assert.deepEqual(normalizeServerSegments({}), []);
  assert.deepEqual(normalizeServerSegments(null), []);
});

test("uses full-attention offline mode only for recordings it covers", async () => {
  const modes = [];
  const post = async (fields) => {
    modes.push(fields.mode);
    return { statusCode: 200, data: { segments: [] } };
  };
  await diarizeViaServer({ wavBuffer: wavOfSeconds(60), post });
  await diarizeViaServer({ wavBuffer: wavOfSeconds(OFFLINE_MODE_MAX_SECONDS), post });
  await diarizeViaServer({ wavBuffer: wavOfSeconds(OFFLINE_MODE_MAX_SECONDS + 1), post });
  await diarizeViaServer({ wavBuffer: wavOfSeconds(0), post });
  assert.deepEqual(modes, ["offline", "offline", "streaming", "streaming"]);
});

test("surfaces the server's error message and flags rejected keys", async () => {
  await assert.rejects(
    diarizeViaServer({
      wavBuffer: wavOfSeconds(10),
      post: async () => ({
        statusCode: 500,
        data: { error: { message: "diarizer model not loaded", type: "server_error" } },
      }),
    }),
    (error) =>
      error instanceof DiarizationServerError &&
      error.statusCode === 500 &&
      error.message === "diarizer model not loaded"
  );
  await assert.rejects(
    diarizeViaServer({
      wavBuffer: wavOfSeconds(10),
      post: async () => ({ statusCode: 401, data: { error: "unauthorized" } }),
    }),
    /rejected the API key/
  );
});

test("a caller abort reaches the in-flight request", async () => {
  const controller = new AbortController();
  let requestSignal = null;
  const pending = diarizeViaServer({
    wavBuffer: wavOfSeconds(10),
    signal: controller.signal,
    post: (_fields, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      );
    },
  });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(requestSignal.aborted, true);
});
