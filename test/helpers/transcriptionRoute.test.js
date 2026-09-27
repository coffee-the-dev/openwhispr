const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionRoute.ts");

const resolve = async (settings, extra = {}) => {
  const { resolveTranscriptionRoute } = await load();
  return resolveTranscriptionRoute({ settings, ...extra });
};

test("self-hosted routes to the configured server and wins over stale flags", async () => {
  const route = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://192.168.1.5:11434/v1",
    remoteTranscriptionModel: "whisper-1",
    useLocalWhisper: true,
  });
  assert.deepEqual(route, {
    transport: "http-batch",
    endpoint: "http://192.168.1.5:11434/v1/audio/transcriptions",
    model: "whisper-1",
    language: undefined,
  });
});

test("self-hosted keeps HTTPS hosts that only resolve on the LAN", async () => {
  const route = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://vllm.lan.example/v1/audio/transcriptions",
  });
  assert.equal(route.transport, "http-batch");
  assert.equal(route.endpoint, "https://vllm.lan.example/v1/audio/transcriptions");
  assert.equal(route.model, null);
});

test("self-hosted mode without a URL fails closed with a translatable reason", async () => {
  for (const remoteTranscriptionUrl of ["", "   ", undefined]) {
    const route = await resolve({ transcriptionMode: "self-hosted", remoteTranscriptionUrl });
    assert.equal(route.transport, "error");
    assert.equal(route.code, "SELF_HOSTED_NOT_CONFIGURED");
    assert.equal(
      route.messageKey,
      "hooks.audioRecording.errorDescriptions.selfHostedNotConfigured"
    );
    assert.match(route.message, /not configured/);
  }
});

test("self-hosted fails closed on invalid or public-http URLs", async () => {
  for (const remoteTranscriptionUrl of [
    "not a url",
    "ftp://localhost:8080",
    "http://example.com/v1",
  ]) {
    const route = await resolve({ transcriptionMode: "self-hosted", remoteTranscriptionUrl });
    assert.equal(route.transport, "error", remoteTranscriptionUrl);
    assert.match(route.message, /invalid or unsupported/, remoteTranscriptionUrl);
  }
});

test("everything that is not self-hosted runs on the local managers", async () => {
  for (const settings of [
    { useLocalWhisper: true, whisperModel: "small" },
    { transcriptionMode: "local" },
    // A leftover remote URL never routes audio off the device on its own.
    { transcriptionMode: "local", remoteTranscriptionUrl: "http://192.168.1.5:8000/v1" },
    {},
  ]) {
    assert.deepEqual(await resolve(settings), { transport: "local" });
  }
});

test("the effective language wins over the preferred one, and auto sends none", async () => {
  const base = {
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://localhost:8000/v1",
  };
  assert.equal((await resolve({ ...base, preferredLanguage: "pt-BR" })).language, "pt");
  assert.equal((await resolve({ ...base, preferredLanguage: "auto" })).language, undefined);
  assert.equal(
    (
      await resolve(
        { ...base, preferredLanguage: "pt-BR" },
        { request: { effectiveLanguage: "de" } }
      )
    ).language,
    "de"
  );
});
