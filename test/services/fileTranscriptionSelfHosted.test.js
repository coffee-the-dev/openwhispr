const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function selfHostedConfig(remoteTranscriptionUrl) {
  return {
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    cohereModel: "cohere-transcribe-03-2026",
    language: "en",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl,
    remoteTranscriptionModel: "whisper-large-v3",
  };
}

test("file transcription enforces self-hosted endpoint security before IPC", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-self-hosted-guard-test-",
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  let ipcCalls = 0;
  window.electronAPI.transcribeAudioFileSelfHosted = async () => {
    ipcCalls += 1;
    return { success: true, text: "must not run" };
  };

  for (const url of ["", "http://public.example.com/v1", "ftp://192.168.1.20/v1"]) {
    const result = await transcribeFile("/tmp/audio.webm", selfHostedConfig(url));
    assert.equal(result.success, false, url);
    assert.equal(result.code, "SELF_HOSTED_NOT_CONFIGURED", url);
  }
  assert.equal(ipcCalls, 0);
});

test("self-hosted file transcription hands the server settings to the main process", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-self-hosted-endpoint-test-",
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  let receivedOptions = null;
  window.electronAPI.transcribeAudioFileSelfHosted = async (options) => {
    receivedOptions = options;
    return { success: true, text: "self-hosted" };
  };

  const result = await transcribeFile(
    "/tmp/audio.webm",
    selfHostedConfig("http://192.168.1.20:9000/v1"),
    { requestId: "upload-1" }
  );

  assert.equal(result.success, true);
  assert.deepEqual(receivedOptions, {
    filePath: "/tmp/audio.webm",
    language: "en",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://192.168.1.20:9000/v1",
    remoteTranscriptionModel: "whisper-large-v3",
    requestId: "upload-1",
  });
});

test("local file transcription never reaches the self-hosted channel", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-local-route-test-",
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  window.electronAPI.transcribeAudioFileSelfHosted = async () => {
    throw new Error("must not run");
  };
  let localOptions = null;
  window.electronAPI.transcribeAudioFile = async (_path, options) => {
    localOptions = options;
    return { success: true, text: "local" };
  };

  const result = await transcribeFile("/tmp/audio.webm", {
    ...selfHostedConfig("http://192.168.1.20:9000/v1"),
    useLocalWhisper: true,
    transcriptionMode: "local",
  });

  assert.equal(result.success, true);
  assert.equal(localOptions.provider, "whisper");
  assert.equal(localOptions.model, "base");
});
