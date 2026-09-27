const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function loadManagerClass(t, mockModules) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-finalization-test-",
    settingsKey: "__streamingFinalizationSettings",
    settings: {
      useLocalWhisper: false,
      transcriptionMode: "providers",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
    },
    mockModules,
  });
  return AudioManager;
}

function createFinalizingManager(AudioManager) {
  const states = [];
  let providerStopCalls = 0;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    isStreaming: true,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    recordingStartTime: Date.now(),
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 7,
    _activeStreamingSessionId: 7,
    _streamingMicSwapPromise: null,
    streamingFinalText: "",
    streamingPartialText: "",
    streamingTextBump: null,
    streamingTextDebounce: null,
    streamingCleanupFns: [],
    streamingProcessor: null,
    streamingSource: null,
    streamingAnalyser: null,
    streamingAudioContext: null,
    streamingStream: null,
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => null,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      finalize() {},
      async stop() {
        providerStopCalls += 1;
        return { success: true };
      },
    }),
    getEffectiveSttLanguage: () => "auto",
    getStreamingProviderName: () => "openai",
    shouldUseStreaming: () => false,
    isRecordingAllowedByPolicy: () => true,
    onStateChange: (state) => states.push(state),
    onTranscriptionComplete() {},
  });
  return { manager, states, getProviderStopCalls: () => providerStopCalls };
}

test("streaming finalization is immediately processing and cannot start another session", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager, states, getProviderStopCalls } = createFinalizingManager(AudioManager);

  const firstStop = manager.stopStreamingRecording();

  assert.equal(manager.isProcessing, true);
  assert.equal(manager.getState().isFinalizingStreaming, true);
  assert.deepEqual(states[0], {
    isRecording: false,
    isProcessing: true,
    isStreaming: false,
  });

  assert.equal(await manager.startStreamingRecording(), false);
  const duplicateStop = manager.stopStreamingRecording();
  assert.deepEqual(await Promise.all([firstStop, duplicateStop]), [true, true]);

  assert.equal(getProviderStopCalls(), 1);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.getState().isFinalizingStreaming, false);
  assert.equal(states.filter((state) => state.isProcessing).length, 1);
  assert.deepEqual(states.at(-1), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
  });
});

test("streaming silence publishes its empty outcome only after processing settles", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const order = [];
  manager.onStateChange = (state) => {
    order.push(state.isProcessing ? "processing" : "idle");
  };
  manager.onTranscriptionComplete = (result) => {
    order.push(result.text === "" ? "empty" : "transcript");
  };

  await manager.stopStreamingRecording();

  assert.deepEqual(order, ["processing", "idle", "empty"]);
});

test("streaming completion keeps the recording occurrence time", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  globalThis.window.dispatchEvent = () => true;
  const recordingStartedAt = Date.parse("2026-09-02T14:00:00.000Z");
  let completion;
  manager.recordingStartTime = recordingStartedAt;
  manager.streamingFinalText = "same event";
  manager.finalizeChineseScript = async (text) => text;
  manager.onTranscriptionComplete = (result) => {
    completion = result;
  };

  await manager.stopStreamingRecording();

  assert.equal(completion.analyticsOccurredAt, new Date(recordingStartedAt).toISOString());
});

test("cancelling an active streaming recording discards it without publishing text", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager, states, getProviderStopCalls } = createFinalizingManager(AudioManager);
  const completions = [];
  manager.streamingFinalText = "discard me";
  manager.cleanupPreview = async () => null;
  manager.onTranscriptionComplete = (result) => completions.push(result);

  assert.equal(await manager.cancelStreamingRecording(), true);

  assert.equal(getProviderStopCalls(), 1);
  assert.deepEqual(completions, []);
  assert.equal(manager._activeStreamingSessionId, null);
  assert.equal(manager.isRecording, false);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.isStreaming, false);
  assert.deepEqual(states.at(-1), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
  });
});

test("streaming discard blocks restart until the provider disconnects", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  let resolveProviderStop;
  let providerStopStarted = false;
  const providerStop = new Promise((resolve) => {
    resolveProviderStop = resolve;
  });
  manager.cleanupPreview = async () => null;
  manager.getStreamingProvider = () => ({
    stop: async () => {
      providerStopStarted = true;
      await providerStop;
      return { success: true };
    },
  });

  const cancel = manager.cancelStreamingRecording();
  while (!providerStopStarted) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.isProcessing, true);
  assert.equal(manager.getState().isFinalizingStreaming, true);
  assert.equal(await manager.startStreamingRecording(), false);

  resolveProviderStop();
  assert.equal(await cancel, true);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.getState().isFinalizingStreaming, false);
});

test("streaming discard waits for an in-progress provider start before disconnecting", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  let providerStopCalls = 0;
  manager.streamingStartInProgress = true;
  manager.cleanupPreview = async () => null;
  manager.getStreamingProvider = () => ({
    stop: async () => {
      providerStopCalls += 1;
      return { success: true };
    },
  });

  const cancel = manager.cancelStreamingRecording();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerStopCalls, 0);
  assert.equal(manager.isProcessing, true);

  manager._settleStreamingStart();
  assert.equal(await cancel, true);
  assert.equal(providerStopCalls, 1);
  assert.equal(manager.isProcessing, false);
});

test("cancelling while the streaming microphone opens never enters recording", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const states = [];
  let resolveMicOpen;
  let micOpenStarted = false;
  const micOpen = new Promise((resolve) => {
    resolveMicOpen = resolve;
  });
  const previousAudioWorkletNode = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { postMessage() {} };
    }

    disconnect() {}
  };
  t.after(() => {
    if (previousAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = previousAudioWorkletNode;
  });

  const stream = {
    getAudioTracks: () => [{ getSettings: () => ({}) }],
    getTracks: () => [{ stop() {} }],
  };
  const source = { connect() {}, disconnect() {} };
  const provider = {
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
    onSessionEnd: () => () => {},
    start: async () => ({ success: true }),
    stop: async () => ({ success: true }),
  };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 0,
    _activeStreamingSessionId: null,
    streamingCleanupFns: [],
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    streamingTextDebounce: null,
    preparedMicCapture: { take: async () => null },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => {
      micOpenStarted = true;
      return micOpen;
    },
    startStreamingFallbackRecorder() {},
    getOrCreateAudioContext: async () => ({
      createMediaStreamSource: () => source,
      createAnalyser: () => ({}),
      audioWorklet: { addModule: async () => {} },
    }),
    getWorkletBlobUrl: () => "",
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => "openai",
    getEffectiveSttLanguage: () => "auto",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    cleanupPreview: async () => null,
    _markCaptureStreamReleased() {},
    onStateChange: (state) => states.push(state),
  });

  const start = manager.startStreamingRecording();
  while (!micOpenStarted) await new Promise((resolve) => setImmediate(resolve));
  const cancel = manager.cancelStreamingRecording();
  resolveMicOpen(stream);

  assert.deepEqual(await Promise.all([start, cancel]), [false, true]);
  assert.equal(manager.isRecording, false);
  assert.equal(manager.isStreaming, false);
  assert.equal(manager.streamingStartInProgress, false);
  assert.equal(
    states.some((state) => state.isRecording),
    false,
    "a cancelled start must not publish a recording state"
  );
});

test("cancel overrides a normal streaming stop before it can publish text", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const completions = [];
  manager.streamingFinalText = "do not paste";
  manager.screenContextPromise = Promise.resolve({ data: "stale-screen" });
  manager.selectionCapturePromise = Promise.resolve({ text: "stale-selection" });
  manager.assistantSelectionContext = { text: "stale-assistant-selection" };
  manager.onTranscriptionComplete = (result) => completions.push(result);

  const stop = manager.stopStreamingRecording();
  const cancel = manager.cancelStreamingRecording();

  assert.equal(await stop, true);
  assert.equal(await cancel, true);
  assert.deepEqual(completions, []);
  assert.equal(manager.screenContextPromise, null);
  assert.equal(manager.selectionCapturePromise, null);
  assert.equal(manager.assistantSelectionContext, null);
  assert.equal(manager._streamingStopPromise, null);
  assert.equal(manager._streamingStopMode, null);
});

test("streaming cancellation aborts a BYOK fallback transcription request", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  let abortCalls = 0;
  manager._activeTranscriptionAbortController = {
    abort() {
      abortCalls += 1;
    },
  };

  manager._requestStreamingCancellation();

  assert.equal(abortCalls, 1);
  assert.equal(manager._activeTranscriptionAbortController, null);
});

test("cancelling streaming processing stays busy until an awaited transform exits", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const completions = [];
  let resolveTransform;
  let transformStarted = false;
  const transform = new Promise((resolve) => {
    resolveTransform = resolve;
  });
  manager.streamingFinalText = "raw transcript";
  manager.finalizeChineseScript = async () => {
    transformStarted = true;
    return transform;
  };
  manager.onTranscriptionComplete = (result) => completions.push(result);

  const stop = manager.stopStreamingRecording();
  while (!transformStarted) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.cancelProcessing(), true);
  assert.equal(manager.isProcessing, true);
  assert.equal(manager.getState().isFinalizingStreaming, true);
  resolveTransform("transformed transcript");
  assert.equal(await stop, true);

  assert.deepEqual(completions, []);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.getState().isFinalizingStreaming, false);
});

test("an older streaming session cannot clean up the active session listeners", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    _activeStreamingSessionId: 12,
    streamingCleanupFns: [() => assert.fail("stale cleanup ran")],
    streamingFinalText: "current transcript",
    streamingPartialText: "current partial",
    streamingTextBump: null,
    streamingTextDebounce: null,
  });

  manager.cleanupStreamingListeners(11);

  assert.equal(manager.streamingCleanupFns.length, 1);
  assert.equal(manager.streamingFinalText, "current transcript");
  assert.equal(manager.streamingPartialText, "current partial");
});

test("Orukeet commits only after the worklet flush and skips settling sleeps", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const order = [];
  const delays = [];
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    delays.push(ms);
    return originalTimeout(callback, ms, ...args);
  });
  manager.streamingProcessor = {
    port: {
      postMessage(message) {
        assert.equal(message, "stop");
        queueMicrotask(() => {
          order.push("last-pcm");
          manager._streamingFlushResolve();
        });
      },
    },
    disconnect() {
      order.push("capture-stopped");
    },
  };
  manager.getStreamingProvider = () => ({
    finalizeAcknowledged: true,
    async finalize() {
      order.push("commit");
      return { success: true, text: "" };
    },
    async stop() {
      order.push("socket-stopped");
      return { success: true, text: "" };
    },
  });
  manager.awaitStreamingTextSettled = () => {
    throw new Error("Unexpected settling delay");
  };
  await manager.stopStreamingRecording();
  assert.deepEqual(order, ["last-pcm", "capture-stopped", "commit", "socket-stopped"]);
  assert.equal(delays.includes(120), false);
  assert.equal(delays.includes(300), false);
});

test("acknowledged streaming silence does not trigger another transcription", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  manager.recordingStartTime = Date.now() - 5000;
  manager.streamingFallbackChunks = [new Blob([new Uint8Array(100)])];
  manager.finishStreamingFallbackSegment = async () => new Blob([new Uint8Array(100)]);
  manager.mergeRecordedSegments = async () => new Blob([new Uint8Array(100)]);
  let fallbackCalls = 0;
  manager.processWithOpenAIAPI = async () => {
    fallbackCalls += 1;
    return { text: "unexpected" };
  };
  manager.getStreamingProvider = () => ({
    finalizeAcknowledged: true,
    finalize: async () => ({ success: true, text: "" }),
    stop: async () => ({ success: true, text: "" }),
  });
  const completions = [];
  manager.onTranscriptionComplete = (result) => completions.push(result);
  assert.equal(await manager.stopStreamingRecording(), true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].text, "");
  assert.equal(fallbackCalls, 0);
});

test("Orukeet uses the acknowledged final even if the transcript event is delayed", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  manager.getStreamingProvider = () => ({
    finalizeAcknowledged: true,
    finalize: async () => ({ success: true, text: "Acknowledged final" }),
    stop: async () => ({ success: true, text: "" }),
  });
  let usageReported;
  const usage = new Promise((resolve) => {
    usageReported = resolve;
  });
  globalThis.window.electronAPI.cloudStreamingUsage = async () => ({ success: true });
  globalThis.window.dispatchEvent = () => usageReported();
  const results = [];
  manager.onTranscriptionComplete = (result) => results.push(result);
  await manager.stopStreamingRecording();
  await usage;
  assert.equal(results[0].text, "Acknowledged final");
});

test("missing Orukeet capture flush never commits a partial recording", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager } = createFinalizingManager(AudioManager);
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) =>
    originalTimeout(callback, Math.min(ms, 10), ...args)
  );
  let stopped = false;
  manager.streamingProcessor = { port: { postMessage() {} }, disconnect() {} };
  manager.getStreamingProvider = () => ({
    finalizeAcknowledged: true,
    finalize: async () => assert.fail("incomplete PCM must not be committed"),
    stop: async () => {
      stopped = true;
      return { success: true, text: "" };
    },
  });
  await manager.stopStreamingRecording();
  assert.equal(stopped, true);
  assert.equal(manager.streamingProcessor, null);
});

function useManagedOrukeetSettings() {
  globalThis.__streamingFinalizationSettings = {
    ...globalThis.__streamingFinalizationSettings,
    cloudTranscriptionMode: "openwhispr",
    isSignedIn: true,
  };
}

// A capture pipeline whose fallback recorder holds "opening words" from the
// moment it starts, before any streaming session exists, and whose worklet
// answers "stop" with the flush sentinel like the real one.
function installCapture(t) {
  const previous = {
    AudioWorkletNode: globalThis.AudioWorkletNode,
    MediaRecorder: globalThis.MediaRecorder,
  };
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = {
        postMessage: (message) => {
          if (message === "stop") queueMicrotask(() => this.port.onmessage?.({ data: "flushed" }));
        },
      };
    }

    connect() {}
    disconnect() {}
  };
  globalThis.MediaRecorder = class {
    constructor() {
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }

    start() {
      this.state = "recording";
      this.ondataavailable({ data: new Blob(["opening words"]) });
    }

    stop() {
      this.state = "inactive";
      queueMicrotask(() => this.onstop?.());
    }
  };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
}

function createStartingManager(AudioManager, { providerName, provider }) {
  const errors = [];
  const uploads = [];
  const completions = [];
  const stream = { getAudioTracks: () => [], getTracks: () => [{ stop() {} }] };
  const source = { connect() {}, disconnect() {} };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 0,
    _activeStreamingSessionId: null,
    _streamingMicSwapPromise: null,
    streamingCleanupFns: [],
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    streamingTextDebounce: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    preparedMicCapture: { take: async () => null },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => stream,
    getOrCreateAudioContext: async () => ({
      createMediaStreamSource: () => source,
      createAnalyser: () => ({}),
      audioWorklet: { addModule: async () => {} },
    }),
    getWorkletBlobUrl: () => "",
    getStreamingProvider: () => provider,
    getStreamingProviderName: () => providerName,
    getEffectiveSttLanguage: () => "auto",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    mergeRecordedSegments: async (segments) => segments[0] ?? null,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    shouldUseStreaming: () => false,
    _markCaptureStreamReleased() {},
    onStateChange() {},
    startRecording: async () => assert.fail("the microphone must not be reopened"),
    processWithOpenWhisprCloud: async (blob, metadata) => {
      uploads.push({ audio: await blob.text(), reason: metadata.streamingFallbackReason });
      return { text: "" };
    },
    onError: (error) => errors.push(error),
    onTranscriptionComplete: (result) => completions.push(result),
  });
  return { manager, errors, uploads, completions };
}

function startingOrukeetProvider(overrides = {}) {
  const sent = [];
  return {
    sent,
    onPartial: () => () => {},
    onFinal: () => () => {},
    onError: () => () => {},
    onSessionEnd: () => () => {},
    send: (pcm) => sent.push(pcm),
    start: async () => ({ success: true }),
    finalizeAcknowledged: true,
    // What main answers once the adapter is gone or failed.
    finalize: async () => ({ success: false, error: "No Orukeet recording is active" }),
    stop: async () => ({ success: true, text: "" }),
    ...overrides,
  };
}

// One 50 ms worklet chunk (800 PCM16 samples at 16 kHz).
const speechPcm = () => new Int16Array(800).fill(8000).buffer;
const silentPcm = () => new Int16Array(800).buffer;

function refusedStartProvider() {
  return startingOrukeetProvider({
    start: async () => ({ success: false, error: "Orukeet connection closed" }),
  });
}

test("a managed Orukeet drop without a fallback recorder surfaces and auto-stops", async (t) => {
  const AudioManager = await loadManagerClass(t);
  useManagedOrukeetSettings();
  installCapture(t);
  globalThis.MediaRecorder = class {
    constructor() {
      throw new Error("MediaRecorder unavailable");
    }
  };
  let raise;
  const provider = startingOrukeetProvider({
    onError: (listener) => {
      raise = listener;
      return () => {};
    },
  });
  const { manager, errors } = createStartingManager(AudioManager, {
    providerName: "orukeet",
    provider,
  });

  assert.equal(await manager.startStreamingRecording(), true);
  raise("Account already has an active recording");

  // Nothing holds the capture, so there is nothing to fail over to.
  assert.equal(errors[0]?.title, "Streaming Error");
  assert.ok(manager._streamingStopPromise, "the recording auto-stops");
  await manager._streamingStopPromise;
});

test("a refused managed Orukeet start without a fallback recorder records in batch instead", async (t) => {
  const AudioManager = await loadManagerClass(t);
  useManagedOrukeetSettings();
  installCapture(t);
  globalThis.MediaRecorder = class {
    constructor() {
      throw new Error("MediaRecorder unavailable");
    }
  };
  const { manager, uploads } = createStartingManager(AudioManager, {
    providerName: "orukeet",
    provider: refusedStartProvider(),
  });
  let batchStarts = 0;
  manager.startRecording = async () => {
    batchStarts += 1;
    return true;
  };
  manager.cleanupStreaming = async () => {};

  assert.equal(await manager.startStreamingRecording(), true);

  // Nothing captured the opening words, so only a fresh recording can.
  assert.equal(batchStarts, 1);
  assert.equal(manager._streamingFailoverReason, null);
  assert.deepEqual(uploads, []);
});

test("the recording after a failed-over one streams to its socket again", async (t) => {
  const AudioManager = await loadManagerClass(t);
  useManagedOrukeetSettings();
  installCapture(t);
  let starts = 0;
  const provider = startingOrukeetProvider({
    start: async () => {
      starts += 1;
      return starts === 1
        ? { success: false, error: "Orukeet connection closed" }
        : { success: true };
    },
  });
  const { manager } = createStartingManager(AudioManager, { providerName: "orukeet", provider });

  assert.equal(await manager.startStreamingRecording(), true);
  await manager.stopStreamingRecording();
  assert.equal(await manager.startStreamingRecording(), true);
  const pcm = speechPcm();
  manager.streamingProcessor.port.onmessage({ data: pcm });

  assert.deepEqual(provider.sent, [pcm]);
});

test("other streaming providers still surface a dropped stream and auto-stop", async (t) => {
  const AudioManager = await loadManagerClass(t);
  useManagedOrukeetSettings();
  installCapture(t);
  let raise;
  const provider = startingOrukeetProvider({
    onError: (listener) => {
      raise = listener;
      return () => {};
    },
    finalizeAcknowledged: false,
  });
  const { manager, errors } = createStartingManager(AudioManager, {
    providerName: "openai-realtime",
    provider,
  });

  assert.equal(await manager.startStreamingRecording(), true);
  raise("Connection lost");

  assert.equal(errors[0].title, "Streaming Error");
  assert.ok(manager._streamingStopPromise, "the recording auto-stops");
  await manager._streamingStopPromise;
});

test("signing out during a failed-over recording reports it and keeps the audio", async (t) => {
  const AudioManager = await loadManagerClass(t);
  useManagedOrukeetSettings();
  installCapture(t);
  const { manager, errors, uploads, completions } = createStartingManager(AudioManager, {
    providerName: "orukeet",
    provider: refusedStartProvider(),
  });
  const saved = [];
  manager.saveFailedTranscription = async (message, code) => saved.push(code);

  await manager.startStreamingRecording();
  globalThis.__streamingFinalizationSettings = {
    ...globalThis.__streamingFinalizationSettings,
    isSignedIn: false,
  };
  await manager.stopStreamingRecording();

  assert.deepEqual(uploads, []);
  assert.deepEqual(
    errors.map(({ code, messageKey }) => ({ code, messageKey })),
    [{ code: "AUTH_REQUIRED", messageKey: "hooks.audioRecording.errorDescriptions.sessionExpired" }]
  );
  assert.deepEqual(saved, ["AUTH_REQUIRED"]);
  assert.deepEqual(completions, []);
});

test("a silent failed-over tap is not uploaded", async (t) => {
  const AudioManager = await loadManagerClass(t);
  useManagedOrukeetSettings();
  installCapture(t);
  const { manager, errors, uploads, completions } = createStartingManager(AudioManager, {
    providerName: "orukeet",
    provider: refusedStartProvider(),
  });

  await manager.startStreamingRecording();
  manager.streamingProcessor.port.onmessage({ data: silentPcm() });
  await manager.stopStreamingRecording();

  assert.deepEqual(uploads, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(completions, [{ success: true, text: "" }]);
});

test("a managed Orukeet session fails over even if its route changes mid-recording", async (t) => {
  const AudioManager = await loadManagerClass(t);
  useManagedOrukeetSettings();
  installCapture(t);
  let raise;
  const { manager, errors } = createStartingManager(AudioManager, {
    providerName: "orukeet",
    provider: startingOrukeetProvider({
      onError: (listener) => {
        raise = listener;
        return () => {};
      },
    }),
  });

  assert.equal(await manager.startStreamingRecording(), true);
  // A background stt-config refresh rolled the account off the Orukeet route.
  manager.getStreamingProviderName = () => "deepgram";
  raise("Account already has an active recording");

  assert.deepEqual(errors, []);
  assert.equal(manager._streamingStopPromise, null, "the recording is not cut off");
  await manager.stopStreamingRecording();
});

const JA_FINAL = {
  success: true,
  text: "ashita no kaigi",
  model: "orukeet-v0.1.0",
  language: "ja",
  languageConfidence: 0.97,
  languageAudioSeconds: 6,
};

const JA_DETECTION = {
  sttDetectedLanguage: "ja",
  sttDetectedLanguageConfidence: 0.97,
  sttDetectedLanguageAudioSeconds: 6,
  sttDetectedLanguageStatus: "detected",
};

const detectionFields = (opts) =>
  Object.fromEntries(Object.entries(opts).filter(([key]) => key.startsWith("sttDetected")));

function orukeetProvider(final) {
  return {
    finalizeAcknowledged: true,
    finalize: async () => final,
    stop: async () => ({ success: true, text: "" }),
  };
}

// Stops a managed Cloud dictation whose provider acknowledged `final`, and
// records what reached Cloud: batch uploads, cleanup requests, streaming usage
// and the published result.
async function stopManagedDictation(
  AudioManager,
  { final, providerName = "orukeet", language = "auto", upload, settings = {}, overrides = {} }
) {
  globalThis.__streamingFinalizationSettings = {
    ...globalThis.__streamingFinalizationSettings,
    cloudTranscriptionMode: "openwhispr",
    isSignedIn: true,
    ...settings,
  };
  const { manager } = createFinalizingManager(AudioManager);
  manager.recordingStartTime = Date.now() - 8000;
  manager.mergeRecordedSegments = async () => new Blob([new Uint8Array(100)]);
  manager.getStreamingProvider = () => orukeetProvider(final);
  manager.getStreamingProviderName = () => providerName;
  manager.getEffectiveSttLanguage = () => language;
  Object.assign(manager, overrides);
  const uploads = [];
  if (upload) {
    manager.processWithOpenWhisprCloud = async (_blob, metadata) => {
      uploads.push(metadata);
      return upload(manager);
    };
  }
  const reasonCalls = [];
  globalThis.window.electronAPI.cloudReason = async (text, opts) => {
    reasonCalls.push([text, opts]);
    return { success: true, text: `${text}。` };
  };
  const usage = [];
  globalThis.window.electronAPI.cloudStreamingUsage = async (_text, _seconds, opts) => {
    usage.push(opts);
    return { success: true };
  };
  let usageSettled;
  const settled = new Promise((resolve) => {
    usageSettled = resolve;
  });
  globalThis.window.dispatchEvent = () => usageSettled();
  const published = [];
  manager.onTranscriptionComplete = (result) => published.push(result);
  const errors = [];
  manager.onError = (error) => errors.push(error);
  const stopResult = await manager.stopStreamingRecording();
  // Usage settles only after a non-empty transcript is published.
  if (published.some((result) => result.text)) await settled;
  return { manager, uploads, reasonCalls, usage, published, errors, stopResult };
}

test("a low score, short window, supported or unknown estimate keeps the Orukeet text", async (t) => {
  const AudioManager = await loadManagerClass(t);
  for (const [final, expected] of [
    [
      { ...JA_FINAL, languageConfidence: 0.89 },
      { ...JA_DETECTION, sttDetectedLanguageConfidence: 0.89 },
    ],
    [
      { ...JA_FINAL, languageAudioSeconds: 2 },
      { ...JA_DETECTION, sttDetectedLanguageAudioSeconds: 2 },
    ],
    [
      { ...JA_FINAL, language: "de" },
      { ...JA_DETECTION, sttDetectedLanguage: "de" },
    ],
    [
      { ...JA_FINAL, language: null, languageConfidence: null },
      { sttDetectedLanguageStatus: "unknown" },
    ],
  ]) {
    const { uploads, usage, published } = await stopManagedDictation(AudioManager, {
      final,
      upload: async () => assert.fail("must not re-transcribe"),
    });
    assert.equal(uploads.length, 0);
    assert.equal(published[0].text, "ashita no kaigi");
    assert.equal(usage.length, 1);
    assert.deepEqual(detectionFields(usage[0]), expected);
  }
});

test("an explicit language setting never re-transcribes", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { uploads, usage, published } = await stopManagedDictation(AudioManager, {
    final: JA_FINAL,
    language: "en",
    upload: async () => assert.fail("must not re-transcribe"),
  });
  assert.equal(uploads.length, 0);
  assert.equal(published[0].text, "ashita no kaigi");
  assert.deepEqual(detectionFields(usage[0]), JA_DETECTION);
});

test("an older gateway sends no detection fields", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { uploads, usage, published } = await stopManagedDictation(AudioManager, {
    final: { success: true, text: "hello there" },
    upload: async () => assert.fail("must not re-transcribe"),
  });
  assert.equal(uploads.length, 0);
  assert.equal(published[0].text, "hello there");
  assert.deepEqual(detectionFields(usage[0]), {});
});

test("only a signed-in OpenWhispr Cloud recording is re-transcribed", async (t) => {
  const AudioManager = await loadManagerClass(t);
  for (const settings of [{ cloudTranscriptionMode: "byok" }, { isSignedIn: false }]) {
    const { uploads, published } = await stopManagedDictation(AudioManager, {
      final: JA_FINAL,
      settings,
      upload: async () => assert.fail("must not upload to Cloud"),
    });
    assert.equal(uploads.length, 0, JSON.stringify(settings));
    assert.equal(published[0].text, "ashita no kaigi");
  }
});

test("kept Orukeet text carries the estimate into streaming cleanup and translation", async (t) => {
  const AudioManager = await loadManagerClass(t, {
    "/stores/settingsStore": `
      export const getSettings = () => globalThis.__streamingFinalizationSettings;
      export const getEffectiveCleanupModel = () => null;
      export const selectResolvedLLMConfig = () => ({ model: null, provider: null });
      export const isCloudCleanupMode = () => true;
      export const isCloudDictationAgentMode = () => false;
      export const isCloudTranslationMode = () => true;
    `,
    "/config/prompts": `
      export const resolvePrompt = () => "translation prompt";
      export const appendScreenContextSuffix = (prompt) => prompt;
    `,
    "/dictationAgentInference": `
      export const resolveDictationAgentInference = () => ({ reachable: false, config: {} });
      export const resolveDictationAgentVisionInference = () => ({ active: false, config: {} });
    `,
    "/dictationTranslationInference": `
      export const resolveDictationTranslationInference = () => ({
        reachable: true, model: "translation-model", config: { provider: "openwhispr" }
      });
    `,
  });
  for (const translationRequested of [false, true]) {
    const { uploads, reasonCalls, usage, published } = await stopManagedDictation(AudioManager, {
      final: { ...JA_FINAL, languageConfidence: 0.89 },
      upload: async () => assert.fail("must not re-transcribe"),
      settings: {
        useCleanupModel: true,
        cleanupCloudMode: "openwhispr",
        customPrompts: {},
        translationSourceLanguage: "en",
        translationTargetLanguage: "es",
      },
      overrides: {
        translationRequested,
        processWithReasoningModel: async () => "translated transcript",
        finalizeChineseScript: async (text) => text,
      },
    });
    const label = translationRequested ? "translation" : "cleanup";
    assert.equal(uploads.length, 0, label);
    assert.equal(
      published[0].text,
      translationRequested ? "translated transcript" : "ashita no kaigi。",
      label
    );
    // The cleanup call writes the combined log the backend's gate reads.
    assert.equal(reasonCalls.length, 1, label);
    assert.deepEqual(
      detectionFields(reasonCalls[0][1]),
      { ...JA_DETECTION, sttDetectedLanguageConfidence: 0.89 },
      label
    );
    assert.equal(usage[0].sendLogs, false, label);
  }
});

test("a non-Orukeet provider is untouched", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { uploads, usage, published } = await stopManagedDictation(AudioManager, {
    final: JA_FINAL,
    providerName: "deepgram",
    upload: async () => assert.fail("must not re-transcribe"),
  });
  assert.equal(uploads.length, 0);
  assert.equal(published[0].text, "ashita no kaigi");
  assert.deepEqual(detectionFields(usage[0]), {});
});
