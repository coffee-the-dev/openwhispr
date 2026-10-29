const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    getAppPath: () => process.cwd(),
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
  },
  shell: {},
  dialog: {},
  net: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

function loadModules() {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return {
      IPCHandlers: require(handlersModulePath),
      DiarizationManager: require("../../src/helpers/diarization.js"),
    };
  } finally {
    Module._load = originalLoad;
  }
}

const { IPCHandlers, DiarizationManager } = loadModules();

// Runs the post-meeting diarization against a fixed cluster timeline and
// resolves with the segments it would send to the renderer.
function diarizeMeeting({
  audioStartedAt,
  segments,
  clusters,
  diarizedSource = "mic",
  rawPcmPath = "/tmp/ow-test-missing.pcm",
  enabled = true,
  keepMeetingAudio = false,
  archived = [],
  noteId = null,
}) {
  const diarizationManager = new DiarizationManager();
  diarizationManager.isAvailable = () => true;
  diarizationManager.convertRawPcmToWav = async () => "/tmp/ow-test-missing.wav";
  diarizationManager.diarize = async () => clusters;

  const fakeThis = Object.assign(Object.create(IPCHandlers.prototype), {
    diarizationRoute: { transport: "local" },
    _diarizationSpeakerReservations: new Map(),
    diarizationManager,
    databaseManager: { getSpeakerProfiles: () => [] },
    speakerDiarizationEnabled: enabled,
    // Meeting audio follows its own timer, even with dictation history off.
    _retentionSettingsSynced: true,
    _retentionSettings: {
      dataRetentionEnabled: false,
      audioRetentionDays: 0,
      meetingAudioRetentionDays: keepMeetingAudio ? 30 : 0,
    },
    _archiveMeetingAudio: async (wavPath, archivedNoteId, startedAt) => {
      archived.push({ wavPath, noteId: archivedNoteId, startedAt });
    },
  });

  return new Promise((resolve) => {
    const win = {
      isDestroyed: () => false,
      webContents: { send: (_channel, payload) => resolve(payload.segments) },
    };
    IPCHandlers.prototype._startOrSkipDiarization.call(
      fakeThis,
      "session-1",
      rawPcmPath,
      audioStartedAt,
      segments,
      win,
      null,
      null,
      noteId,
      diarizedSource
    );
  });
}

const T0 = 1_791_000_000_000;

test("batches are placed on the diarization timeline by when their audio started", async () => {
  // Each 5 s batch's text comes back 1.5 s after the batch closed, so its
  // timestamp sits inside the next batch's audio.
  const batch = (startSeconds, text) => ({
    text,
    source: "mic",
    audioStartedAt: T0 + startSeconds * 1000,
    timestamp: T0 + (startSeconds + 5 + 1.5) * 1000,
  });

  const merged = await diarizeMeeting({
    audioStartedAt: T0,
    segments: [batch(0, "steve one"), batch(5, "dan one"), batch(10, "steve two")],
    clusters: [
      { start: 0, end: 5, speaker: "A" },
      { start: 5, end: 10, speaker: "B" },
      { start: 10, end: 15, speaker: "A" },
    ],
  });

  const speakerOf = (text) => merged.find((segment) => segment.text === text).speaker;
  assert.equal(speakerOf("steve one"), speakerOf("steve two"));
  assert.notEqual(speakerOf("steve one"), speakerOf("dan one"));
  assert.deepEqual(
    merged.map((segment) => segment.timestamp),
    [0, 5, 10]
  );
  assert.ok(merged.every((segment) => !("audioStartedAt" in segment)));
});

test("segments without an audio start keep their timestamp", async () => {
  const merged = await diarizeMeeting({
    audioStartedAt: T0,
    segments: [{ text: "hello", source: "mic", timestamp: T0 + 2000 }],
    clusters: [
      { start: 0, end: 5, speaker: "A" },
      { start: 5, end: 10, speaker: "B" },
    ],
  });

  assert.equal(merged[0].timestamp, 2);
  assert.equal(merged[0].speaker, "speaker_0");
});

test("a skipped diarization run still deletes the raw capture", async () => {
  const rawPcmPath = path.join(os.tmpdir(), `ow-diarize-raw-mic-test-${process.pid}.pcm`);
  fs.writeFileSync(rawPcmPath, Buffer.alloc(4800));

  const merged = await diarizeMeeting({
    audioStartedAt: T0,
    segments: [{ text: "hello", source: "mic", timestamp: T0 + 2000 }],
    clusters: [],
    rawPcmPath,
    enabled: false,
  });

  assert.equal(merged.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 20 && fs.existsSync(rawPcmPath); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(rawPcmPath), false);
});

const waitFor = async (condition) => {
  for (let i = 0; i < 50 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("kept meeting audio is archived from the diarizer's WAV", async () => {
  const archived = [];
  await diarizeMeeting({
    audioStartedAt: T0,
    segments: [{ text: "hello", source: "mic", timestamp: T0 + 2000 }],
    clusters: [{ start: 0, end: 5, speaker: "A" }],
    keepMeetingAudio: true,
    archived,
    noteId: 25,
  });

  await waitFor(() => archived.length > 0);
  assert.deepEqual(archived, [{ wavPath: "/tmp/ow-test-missing.wav", noteId: 25, startedAt: T0 }]);
});

test("meeting audio is not archived while Audio Retention is disabled", async () => {
  const archived = [];
  await diarizeMeeting({
    audioStartedAt: T0,
    segments: [{ text: "hello", source: "mic", timestamp: T0 + 2000 }],
    clusters: [{ start: 0, end: 5, speaker: "A" }],
    archived,
    noteId: 25,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(archived, []);
});

test("a skipped diarization run still archives kept audio before deleting the capture", async () => {
  const rawPcmPath = path.join(os.tmpdir(), `ow-diarize-raw-mic-keep-${process.pid}.pcm`);
  fs.writeFileSync(rawPcmPath, Buffer.alloc(4800));
  const archived = [];

  await diarizeMeeting({
    audioStartedAt: T0,
    segments: [{ text: "hello", source: "mic", timestamp: T0 + 2000 }],
    clusters: [],
    rawPcmPath,
    enabled: false,
    keepMeetingAudio: true,
    archived,
    noteId: 7,
  });

  await waitFor(() => archived.length > 0 && !fs.existsSync(rawPcmPath));
  assert.deepEqual(archived, [{ wavPath: "/tmp/ow-test-missing.wav", noteId: 7, startedAt: T0 }]);
  assert.equal(fs.existsSync(rawPcmPath), false);
});
