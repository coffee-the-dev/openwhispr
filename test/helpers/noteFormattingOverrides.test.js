const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/noteFormattingOverrides.js");

test("self-hosted forwards remoteUrl as lanUrl and the api key", async () => {
  const { buildNoteFormattingOverrides } = await load();
  const overrides = buildNoteFormattingOverrides({
    mode: "self-hosted",
    remoteUrl: "http://192.168.1.126:11434/v1",
    model: "llama3",
    customApiKey: "sk-local",
  });
  assert.deepEqual(overrides, {
    inferenceScope: "noteFormatting",
    provider: undefined,
    customApiKey: "sk-local",
    lanUrl: "http://192.168.1.126:11434/v1",
  });
});

test("self-hosted with no key still routes via lanUrl", async () => {
  const { buildNoteFormattingOverrides } = await load();
  const overrides = buildNoteFormattingOverrides({
    mode: "self-hosted",
    remoteUrl: "http://host:8080/v1",
    customApiKey: "",
  });
  assert.equal(overrides.lanUrl, "http://host:8080/v1");
  assert.equal(overrides.customApiKey, undefined);
});

// Without a pinned provider processText falls back to the dictation-cleanup
// scope, which may run somewhere else entirely.
test("local mode pins the local runtime and never forwards a key", async () => {
  const { buildNoteFormattingOverrides } = await load();
  const overrides = buildNoteFormattingOverrides({
    mode: "local",
    provider: "qwen",
    remoteUrl: "http://host:8080/v1",
    customApiKey: "secret",
  });
  assert.deepEqual(overrides, {
    inferenceScope: "noteFormatting",
    provider: "local",
    customApiKey: undefined,
    lanUrl: undefined,
  });
});
