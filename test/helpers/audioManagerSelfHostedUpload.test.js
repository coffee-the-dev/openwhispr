const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");

async function loadSelfHostedManager(t, decode, settings = {}) {
  const originalContext = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    decodeAudioData() {
      return decode();
    }
  };
  t.after(() => {
    if (originalContext === undefined) delete globalThis.OfflineAudioContext;
    else globalThis.OfflineAudioContext = originalContext;
  });
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-self-hosted-upload-test-",
    settingsKey: "__selfHostedUploadSettings",
    settings: {
      useLocalWhisper: false,
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://stt.example.com/v1",
      remoteTranscriptionModel: "whisper-1",
      allowLocalFallback: false,
      ...settings,
    },
  });
  return createManager({
    isProcessing: true,
    _processingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _localSpeechGateState: null,
    getEffectiveSttLanguage: () => "auto",
    getSelfHostedApiKey: async () => "test-key",
    getWhisperPrompt: () => null,
    isDictionaryEcho: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
    onStateChange() {},
  });
}

function decodedAudio(frameCount = 8) {
  const samples = new Float32Array(frameCount);
  return { sampleRate: 16000, numberOfChannels: 1, getChannelData: () => samples };
}

test("self-hosted dictation preserves the original when WAV would exceed the upload limit", async (t) => {
  const originalAudio = new Blob(["original recording"], { type: "audio/webm" });
  for (const { wavBytes, expectedType } of [
    { wavBytes: 60, expectedType: "audio/wav" },
    { wavBytes: 25 * 1024 * 1024, expectedType: "audio/wav" },
    { wavBytes: 25 * 1024 * 1024 + 2, expectedType: "audio/webm" },
  ]) {
    await t.test(`${wavBytes} byte WAV uploads as ${expectedType}`, async (t) => {
      const manager = await loadSelfHostedManager(t, async () => decodedAudio((wavBytes - 44) / 2));
      let request;
      let uploadedPart;
      t.mock.method(globalThis, "fetch", async (url, init) => {
        request = { url, init };
        uploadedPart = init.body.get("file");
        return new Response(JSON.stringify({ text: "transcribed" }), { status: 200 });
      });

      const result = await manager.processWithSelfHosted(originalAudio);

      assert.equal(result.text, "transcribed");
      assert.equal(result.source, "self-hosted");
      assert.equal(request.url, "https://stt.example.com/v1/audio/transcriptions");
      assert.equal(request.init.headers.Authorization, "Bearer test-key");
      assert.equal(request.init.body.get("model"), "whisper-1");
      assert.equal(uploadedPart.type, expectedType);
      assert.equal(uploadedPart.name, expectedType === "audio/wav" ? "audio.wav" : "audio.webm");
      if (expectedType === "audio/webm") {
        assert.deepEqual(await uploadedPart.arrayBuffer(), await originalAudio.arrayBuffer());
      } else {
        assert.equal(uploadedPart.size, wavBytes);
        assert.equal(await uploadedPart.slice(0, 4).text(), "RIFF");
      }
    });
  }
});

for (const conversionFails of [false, true]) {
  test(`cancelled conversion cannot upload or replace a newer request (${conversionFails ? "failure" : "success"})`, async (t) => {
    const conversionStarted = deferred();
    const finishConversion = deferred();
    let decodeCalls = 0;
    const manager = await loadSelfHostedManager(t, async () => {
      if (++decodeCalls === 1) {
        conversionStarted.resolve();
        await finishConversion.promise;
        if (conversionFails) throw new Error("Cannot decode recording");
      }
      return decodedAudio();
    });
    const requestStarted = deferred();
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requests.push(init);
      requestStarted.resolve();
      if (requests.length > 1) {
        return new Response(JSON.stringify({ text: "cancelled recording" }), { status: 200 });
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("Cancelled", "AbortError"))
        );
      });
    });
    const firstRun = manager.processAudio(new Blob(["first"], { type: "audio/webm" }));
    await conversionStarted.promise;
    assert.equal(manager.cancelProcessing(), true);
    manager.isProcessing = true;
    const secondRun = manager.processAudio(new Blob(["second"], { type: "audio/webm" }));
    await requestStarted.promise;
    const secondController = manager._activeTranscriptionAbortController;

    finishConversion.resolve();
    await firstRun;
    const requestCount = requests.length;
    const currentController = manager._activeTranscriptionAbortController;
    manager.cancelProcessing();
    const secondRequestAborted = requests[0].signal.aborted;
    secondController.abort();
    await Promise.all([firstRun, secondRun]);

    assert.equal(requestCount, 1, "cancelled audio must not be uploaded");
    assert.equal(
      currentController,
      secondController,
      "the newer request must retain cancellation ownership"
    );
    assert.equal(secondRequestAborted, true);
  });
}

test("an unconfigured self-hosted server fails closed before any upload", async (t) => {
  const manager = await loadSelfHostedManager(t, async () => decodedAudio(), {
    remoteTranscriptionUrl: "",
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not upload");
  });

  await assert.rejects(
    manager.processWithSelfHosted(new Blob(["audio"], { type: "audio/wav" })),
    (error) => {
      assert.equal(error.code, "SELF_HOSTED_NOT_CONFIGURED");
      assert.equal(
        error.messageKey,
        "hooks.audioRecording.errorDescriptions.selfHostedNotConfigured"
      );
      return true;
    }
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a self-hosted server without a saved key receives no Authorization header", async (t) => {
  const manager = await loadSelfHostedManager(t, async () => decodedAudio());
  manager.getSelfHostedApiKey = async () => null;
  let headers;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    headers = init.headers;
    return new Response(JSON.stringify({ text: "transcribed" }), { status: 200 });
  });

  await manager.processWithSelfHosted(new Blob(["audio"], { type: "audio/wav" }));

  assert.deepEqual(headers, {});
});
