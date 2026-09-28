const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mapVerboseSegments,
  rejectsResponseFormat,
  requestTranscription,
  resetResponseFormatCache,
  stitchTranscriptionChunks,
} = require("../../src/helpers/selfHostedFileTranscription.js");

function fakePost(responses) {
  const calls = [];
  const post = async (fields) => {
    calls.push(fields);
    return responses.shift();
  };
  return { calls, post };
}

test("maps verbose_json segments onto the chunk's timeline", () => {
  assert.deepEqual(
    mapVerboseSegments(
      {
        segments: [
          { text: " Hello. ", start: 0, end: 1.5 },
          { text: "", start: 2, end: 3 },
          { text: "Bad", start: "x", end: 4 },
          { text: "World", start: 2, end: 1 },
        ],
      },
      600
    ),
    [
      { text: "Hello.", start: 600, end: 601.5 },
      { text: "World", start: 602, end: 602 },
    ]
  );
  assert.deepEqual(mapVerboseSegments({ text: "no segments" }), []);
});

test("only format-shaped 4xx responses trigger the json fallback", () => {
  for (const status of [400, 404, 415, 422]) assert.equal(rejectsResponseFormat(status), true);
  for (const status of [200, 401, 403, 408, 413, 429, 500]) {
    assert.equal(rejectsResponseFormat(status), false);
  }
});

test("returns timed segments when the server honors verbose_json", async () => {
  resetResponseFormatCache();
  const { calls, post } = fakePost([
    {
      statusCode: 200,
      data: { text: "Hi there.", segments: [{ text: "Hi there.", start: 0.2, end: 1.1 }] },
    },
  ]);
  const result = await requestTranscription({ post, endpoint: "https://a/v1/audio", model: "m" });
  assert.deepEqual(calls, [
    { model: "m", response_format: "verbose_json", "timestamp_granularities[]": "segment" },
  ]);
  assert.equal(result.text, "Hi there.");
  assert.deepEqual(result.segments, [{ text: "Hi there.", start: 0.2, end: 1.1 }]);
});

test("a rejected verbose_json retries as json and is remembered per endpoint", async () => {
  resetResponseFormatCache();
  const first = fakePost([
    { statusCode: 400, data: { error: { message: "unsupported response_format" } } },
    { statusCode: 200, data: { text: "plain" } },
  ]);
  const result = await requestTranscription({ post: first.post, endpoint: "https://b/v1/audio" });
  assert.deepEqual(
    first.calls.map((c) => c.response_format),
    ["verbose_json", "json"]
  );
  assert.equal("model" in first.calls[0], false);
  assert.deepEqual(
    { text: result.text, segments: result.segments },
    { text: "plain", segments: null }
  );

  const second = fakePost([{ statusCode: 200, data: { text: "again" } }]);
  await requestTranscription({ post: second.post, endpoint: "https://b/v1/audio" });
  assert.deepEqual(
    second.calls.map((c) => c.response_format),
    ["json"]
  );

  // A different server still gets asked for segments.
  const other = fakePost([{ statusCode: 200, data: { text: "x", segments: [] } }]);
  await requestTranscription({ post: other.post, endpoint: "https://c/v1/audio" });
  assert.equal(other.calls[0].response_format, "verbose_json");
});

test("verbose_json without segments keeps its text and skips verbose next time", async () => {
  resetResponseFormatCache();
  const first = fakePost([{ statusCode: 200, data: { text: "only text" } }]);
  const result = await requestTranscription({ post: first.post, endpoint: "https://d/v1/audio" });
  assert.equal(first.calls.length, 1);
  assert.deepEqual(
    { text: result.text, segments: result.segments },
    {
      text: "only text",
      segments: null,
    }
  );

  const second = fakePost([{ statusCode: 200, data: { text: "next" } }]);
  await requestTranscription({ post: second.post, endpoint: "https://d/v1/audio" });
  assert.equal(second.calls[0].response_format, "json");
});

test("auth failures are returned as-is without a json retry", async () => {
  resetResponseFormatCache();
  const { calls, post } = fakePost([{ statusCode: 401, data: {} }]);
  const result = await requestTranscription({ post, endpoint: "https://e/v1/audio" });
  assert.equal(result.statusCode, 401);
  assert.equal(calls.length, 1);
});

test("stitches chunk transcripts; segments survive only if every chunk had them", () => {
  const a = { text: "one", segments: [{ text: "one", start: 0, end: 1 }] };
  const b = { text: "two", segments: [{ text: "two", start: 600, end: 601 }] };
  assert.deepEqual(stitchTranscriptionChunks([a, b]), {
    text: "one two",
    segments: [...a.segments, ...b.segments],
  });
  assert.deepEqual(stitchTranscriptionChunks([a, { text: "two", segments: null }]), {
    text: "one two",
    segments: null,
  });
});
