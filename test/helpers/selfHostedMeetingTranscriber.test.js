const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MEETING_REMOTE_MAX_BACKLOG_BYTES,
  capMeetingBacklog,
  createSelfHostedChunkTranscriber,
  isTransientTranscriptionFailure,
} = require("../../src/helpers/selfHostedMeetingTranscriber.js");

test("a backlog within the cap passes through untouched", () => {
  const chunks = [Buffer.alloc(100), Buffer.alloc(200)];
  const result = capMeetingBacklog(chunks, 400);
  assert.equal(result.chunks, chunks);
  assert.equal(result.droppedBytes, 0);
});

test("an over-long backlog keeps the newest audio, sample-aligned", () => {
  const oldest = Buffer.alloc(300, 1);
  const middle = Buffer.alloc(301, 2);
  const newest = Buffer.alloc(200, 3);
  const { chunks, droppedBytes } = capMeetingBacklog([oldest, middle, newest], 451);

  const kept = Buffer.concat(chunks);
  // 451 bytes of room: the newest 200, then 250 (not 251) from the middle.
  assert.equal(kept.length, 450);
  assert.equal(droppedBytes, 801 - 450);
  assert.ok(kept.subarray(0, 250).every((b) => b === 2));
  assert.ok(kept.subarray(250).every((b) => b === 3));
});

test("the default cap is 30 seconds of 24 kHz 16-bit PCM", () => {
  assert.equal(MEETING_REMOTE_MAX_BACKLOG_BYTES, 30 * 24000 * 2);
});

test("network failures and retryable statuses are transient; others are not", () => {
  assert.equal(isTransientTranscriptionFailure(new Error("fetch failed")), true);
  assert.equal(isTransientTranscriptionFailure(Object.assign(new Error(), { status: 503 })), true);
  assert.equal(isTransientTranscriptionFailure(Object.assign(new Error(), { status: 429 })), true);
  assert.equal(isTransientTranscriptionFailure(Object.assign(new Error(), { status: 401 })), false);
  assert.equal(isTransientTranscriptionFailure(Object.assign(new Error(), { status: 400 })), false);
});

function recordingFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(init.body.entries()) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

test("posts a WAV chunk with model, language and the saved key", async () => {
  const { calls, fetchImpl } = recordingFetch([Response.json({ text: " hello there " })]);
  const transcriber = createSelfHostedChunkTranscriber({
    endpoint: "https://vllm.ash.example/v1/audio/transcriptions",
    model: "whisper-1",
    language: "en",
    getHeaders: () => ({ Authorization: "Bearer k" }),
    fetchImpl,
  });

  assert.deepEqual(await transcriber.transcribe(Buffer.from("RIFF")), {
    success: true,
    text: "hello there",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://vllm.ash.example/v1/audio/transcriptions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.equal(calls[0].form.model, "whisper-1");
  assert.equal(calls[0].form.language, "en");
  assert.equal(calls[0].form.response_format, "json");
  assert.equal(calls[0].form.file.type, "audio/wav");
});

test("retries a transient failure exactly once", async () => {
  const { calls, fetchImpl } = recordingFetch([
    new Response("busy", { status: 503 }),
    Response.json({ text: "second try" }),
  ]);
  const transcriber = createSelfHostedChunkTranscriber({
    endpoint: "https://s/v1/audio/transcriptions",
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal((await transcriber.transcribe(Buffer.alloc(4))).text, "second try");
  assert.equal(calls.length, 2);
  assert.equal("model" in calls[0].form, false);

  const twice = recordingFetch([new Error("down"), new Error("still down")]);
  const failing = createSelfHostedChunkTranscriber({
    endpoint: "https://s/v1/audio/transcriptions",
    fetchImpl: twice.fetchImpl,
    retryDelayMs: 0,
  });
  await assert.rejects(failing.transcribe(Buffer.alloc(4)), /still down/);
  assert.equal(twice.calls.length, 2);
});

test("does not retry a rejected key", async () => {
  const { calls, fetchImpl } = recordingFetch([new Response("no", { status: 401 })]);
  const transcriber = createSelfHostedChunkTranscriber({
    endpoint: "https://s/v1/audio/transcriptions",
    fetchImpl,
    retryDelayMs: 0,
  });
  await assert.rejects(transcriber.transcribe(Buffer.alloc(4)), { status: 401 });
  assert.equal(calls.length, 1);
});

test("accepts a bare-text answer to a json request", async () => {
  const { fetchImpl } = recordingFetch([new Response("plain words\n", { status: 200 })]);
  const transcriber = createSelfHostedChunkTranscriber({
    endpoint: "https://s/v1/audio/transcriptions",
    fetchImpl,
  });
  assert.equal((await transcriber.transcribe(Buffer.alloc(4))).text, "plain words");
});
