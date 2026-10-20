const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");
const { installMicCaptureGlobals } = require("../lib/rendererTestHarness");

// A recording's spool must last exactly until its own result is saved (#2073):
// a spool left open becomes a phantom history row on the next launch, and one
// ended early loses the audio a hung main process would otherwise hand back.

const keptAudio = { dataRetentionEnabled: true, audioRetentionDays: 30 };

async function load(t, settings = keptAudio) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-interrupted-recording-test-",
    settingsKey: "__interruptedRecordingSettings",
    settings,
    mockModules: {
      "/recordingSpool": `
        export const startRecordingSpool = (routeKind) => globalThis.__interruptedSpools.start(routeKind);
        export const takeInterruptedRecordings = () => globalThis.__interruptedSpools.take();
      `,
    },
  });
  t.after(() => {
    delete globalThis.__interruptedSpools;
  });
  return loaded;
}

function fakeSpool(name) {
  const spool = {
    name,
    segments: [],
    finished: false,
    addSegment(mimeType) {
      const chunks = [];
      spool.segments.push({ mimeType, chunks });
      return (chunk) => chunks.push(chunk);
    },
    finish() {
      spool.finished = true;
    },
  };
  return spool;
}

function interrupted(segments) {
  const recording = {
    startedAt: Date.parse("2026-09-05T08:00:00.000Z"),
    durationMs: 14 * 60 * 1000,
    routeKind: "translation",
    segments,
    discarded: false,
    discard: () => (recording.discarded = true),
  };
  return recording;
}

const audio = (bytes = 4096) => new Blob([new Uint8Array(bytes)], { type: "audio/webm" });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an interrupted recording comes back as a failed row with its audio, then leaves the spool", async (t) => {
  const { createManager, window } = await load(t);
  const recording = interrupted([audio()]);
  globalThis.__interruptedSpools = { take: async () => [recording] };
  const saved = [];
  window.electronAPI.saveTranscription = async (text, rawText, options) => {
    saved.push({ text, rawText, options });
    return { id: 7 };
  };
  window.electronAPI.saveTranscriptionAudio = async (id, buffer, metadata) => {
    saved.push({ id, bytes: buffer.byteLength, metadata });
    return { success: true };
  };

  await createManager().recoverInterruptedRecordings("OpenWhispr closed early.");

  assert.deepEqual(saved, [
    {
      text: "",
      rawText: null,
      options: {
        status: "failed",
        errorMessage: "OpenWhispr closed early.",
        errorCode: "CRASH_RECOVERY",
        routeKind: "translation",
        analyticsOccurredAt: "2026-09-05T08:00:00.000Z",
      },
    },
    { id: 7, bytes: 4096, metadata: { durationMs: 840000, provider: null, model: null } },
  ]);
  assert.equal(recording.discarded, true);
});

test("a row whose audio didn't save is removed and the recording stays spooled", async (t) => {
  const { createManager, window } = await load(t);
  const recording = interrupted([audio()]);
  globalThis.__interruptedSpools = { take: async () => [recording] };
  const deleted = [];
  window.electronAPI.saveTranscription = async () => ({ id: 9 });
  window.electronAPI.saveTranscriptionAudio = async () => ({ success: false });
  window.electronAPI.deleteTranscription = async (id) => deleted.push(id);

  await createManager().recoverInterruptedRecordings("message");

  assert.deepEqual(deleted, [9]);
  assert.equal(recording.discarded, false, "the next launch tries again");
});

test("audio the user doesn't keep is dropped, not recovered", async (t) => {
  for (const settings of [
    { dataRetentionEnabled: false, audioRetentionDays: 30 },
    { dataRetentionEnabled: true, audioRetentionDays: 0 },
  ]) {
    const { createManager, window } = await load(t, settings);
    const recording = interrupted([audio()]);
    globalThis.__interruptedSpools = { take: async () => [recording] };
    window.electronAPI.saveTranscription = async () => assert.fail("nothing should be saved");

    await createManager().recoverInterruptedRecordings("message");

    assert.equal(recording.discarded, true);
  }
});

test("a spool that only holds the container header is dropped without a row", async (t) => {
  const { createManager, window } = await load(t);
  const recording = interrupted([audio(120)]);
  globalThis.__interruptedSpools = { take: async () => [recording] };
  window.electronAPI.saveTranscription = async () => assert.fail("nothing should be saved");

  await createManager().recoverInterruptedRecordings("message");

  assert.equal(recording.discarded, true);
});

test("recordings are only spooled when their audio would be kept, with their route", async (t) => {
  const { createManager, setSettings } = await load(t);
  const routes = [];
  globalThis.__interruptedSpools = {
    start: (routeKind) => {
      routes.push(routeKind);
      return fakeSpool("kept");
    },
  };
  const manager = createManager({ translationRequested: true });

  assert.equal(manager._startRecordingSpool().name, "kept");
  assert.deepEqual(routes, ["translation"]);
  setSettings({ dataRetentionEnabled: true, audioRetentionDays: 0 });
  assert.equal(manager._startRecordingSpool(), null);
});

const fakeRecorder = () => ({ state: "recording", mimeType: "audio/webm;codecs=opus" });

test("a batch recording spools from its first chunk", async (t) => {
  const { AudioManager } = await load(t);
  installMicCaptureGlobals(t);
  const spool = fakeSpool("batch");
  globalThis.__interruptedSpools = { start: () => spool };
  const recorder = fakeRecorder();
  const preRollChunk = audio(300);
  const stream = { getAudioTracks: () => [], getTracks: () => [] };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    mediaRecorder: null,
    _batchPcmTap: null,
    _batchSegments: [],
    audioChunks: [],
    preparedMicCapture: {
      take: async () => ({
        stream,
        constraints: { audio: true },
        recorder,
        chunks: [preRollChunk],
        pcmTap: null,
        startedAt: Date.now(),
      }),
    },
    beginMicRecovery: async () => {},
    onStateChange() {},
  });
  t.after(() => manager.teardownSpeechGate());

  assert.equal(await manager.startRecording(), true);
  const chunk = audio(500);
  recorder.ondataavailable({ data: chunk });

  assert.equal(manager._recordingSpool, spool);
  assert.deepEqual(spool.segments[0].chunks, [preRollChunk, chunk]);
});

function batchManager(AudioManager) {
  return Object.assign(Object.create(AudioManager.prototype), {
    _batchPcmTap: null,
    teardownSpeechGate() {},
    cleanupPreview() {},
    _closeBatchPcmTap() {},
    onStateChange() {},
  });
}

test("a cancelled recorder's last chunk stays out of the next recording's spool", async (t) => {
  const { AudioManager } = await load(t);
  const manager = batchManager(AudioManager);
  const first = fakeSpool("first");
  const second = fakeSpool("second");
  const cancelled = fakeRecorder();
  const preRoll = audio(300);

  manager._recordingSpool = first;
  manager.createBatchRecorder(null, { recorder: cancelled, chunks: [preRoll] });
  manager.resetDiscardedBatchRecordingState();
  manager._recordingSpool = second;
  manager.createBatchRecorder(null, { recorder: fakeRecorder(), chunks: [] });
  const late = audio(500);
  cancelled.ondataavailable({ data: late });

  assert.equal(first.finished, true);
  assert.deepEqual(first.segments[0].chunks, [preRoll, late]);
  assert.deepEqual(second.segments[0].chunks, []);
  assert.equal(second.finished, false);
});

test("a microphone swap adds a segment to the same recording's spool", async (t) => {
  const { AudioManager } = await load(t);
  const manager = batchManager(AudioManager);
  const spool = fakeSpool("one");

  manager._recordingSpool = spool;
  manager.createBatchRecorder(null, { recorder: fakeRecorder(), chunks: [] });
  manager.createBatchRecorder(null, { recorder: fakeRecorder(), chunks: [] });

  assert.equal(spool.segments.length, 2);
  assert.equal(manager._recordingSpool, spool);
});

test("a pipeline that settles late ends its own spool, not the next recording's", async (t) => {
  const { createManager } = await load(t);
  const pipeline = deferred();
  const first = fakeSpool("first");
  const second = fakeSpool("second");
  const manager = createManager({ _finalizeBatchRecording: () => pipeline.promise });

  manager._recordingSpool = first;
  const finalization = manager.finalizeBatchRecording(audio());
  manager._recordingSpool = second;
  assert.equal(first.finished, false, "kept until the pipeline is done with the audio");
  pipeline.resolve();
  await finalization;

  assert.equal(first.finished, true);
  assert.equal(second.finished, false);
  assert.equal(manager._recordingSpool, second);
});

test("a batch spool lasts until the transcript is delivered and saved", async (t) => {
  const { createManager } = await load(t);
  const handled = deferred();
  const spool = fakeSpool("batch");
  const manager = createManager({
    isRecording: true,
    _recordingSpool: spool,
    _processingCancellationGeneration: 0,
    _batchSegments: [],
    _receivedAudioData: true,
    _streamingCommitActive: false,
    recordingMimeType: "audio/webm",
    recordingStartTime: Date.now(),
    micRecovery: { stop() {} },
    teardownSpeechGate() {},
    cleanupPreview: async () => null,
    shouldShowPreviewCleanupState: () => false,
    mergeRecordedSegments: async () => audio(),
    processAudio: async (_blob, _metadata, pipeline) => {
      pipeline.resultHandled = handled.promise;
    },
    onStateChange() {},
  });

  const finalization = manager.finalizeBatchRecording(audio());
  await tick();
  assert.equal(spool.finished, false, "the paste and the save may still be waiting on main");
  handled.resolve(true);
  await finalization;

  assert.equal(spool.finished, true);
});

function processingManager(createManager, transcription) {
  return createManager({
    isProcessing: true,
    _localSpeechGateState: null,
    _processingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    lastAudioBlob: audio(),
    processWithLocalWhisper: () => transcription,
    onStateChange() {},
    onNoAudio() {},
    onError() {},
  });
}

test("processing hands the delivered result, or the failed save, to its pipeline", async (t) => {
  const { createManager } = await load(t, {
    ...keptAudio,
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
  });
  const delivered = Promise.resolve("delivered");
  const succeeding = processingManager(
    createManager,
    Promise.resolve({ success: true, text: "hello", source: "local", timings: {} })
  );
  succeeding.onTranscriptionComplete = () => delivered;
  const success = succeeding._startProcessingPipeline();
  await succeeding.processAudio(audio(), {}, success);

  const saved = Promise.resolve("saved");
  const failing = processingManager(createManager, Promise.reject(new Error("model crashed")));
  failing.saveFailedTranscription = () => saved;
  const failure = failing._startProcessingPipeline();
  await failing.processAudio(audio(), {}, failure);

  assert.strictEqual(success.resultHandled, delivered);
  assert.strictEqual(failure.resultHandled, saved);
});
