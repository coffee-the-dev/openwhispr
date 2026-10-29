const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-rediarize-test-"));
const archiveDir = path.join(userData, "meeting-audio");
const originalLoad = Module._load;

const electronStub = {
  app: {
    getPath: () => userData,
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

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};
const IPCHandlers = require("../../src/helpers/ipcHandlers");
const DiarizationManager = require("../../src/helpers/diarization.js");
const ffmpegUtils = require("../../src/helpers/ffmpegUtils");
Module._load = originalLoad;

// The archived MP3 is never decoded here: the diarizer below is canned.
ffmpegUtils.convertToWav = async () => {};

const STARTED_AT = Date.UTC(2026, 9, 28, 21, 19, 36);

function archive(noteId, startedAt = STARTED_AT) {
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(archiveDir, `note-${noteId}-${stamp}.mp3`), "");
}

function handlersFor({ transcript, clusters, diarizeCalls = [], replaced = [] }) {
  const diarizationManager = new DiarizationManager();
  diarizationManager.isAvailable = () => true;
  diarizationManager.diarize = async (_wav, options) => {
    diarizeCalls.push(options);
    return clusters;
  };
  return Object.assign(Object.create(IPCHandlers.prototype), {
    diarizationRoute: { transport: "local" },
    diarizationManager,
    databaseManager: {
      getNote: () => ({ transcript: JSON.stringify(transcript) }),
      getSpeakerProfiles: () => [],
      replaceNoteSpeakers: (noteId, embeddings) => replaced.push({ noteId, embeddings }),
    },
  });
}

test("re-detects a call's remote speakers with the corrected head count", async () => {
  archive(54);
  const transcript = [
    { text: "hi", source: "mic", timestamp: 1, speaker: "you" },
    { text: "first", source: "system", timestamp: 10, speaker: "speaker_0", speakerName: "Dan" },
    { text: "second", source: "system", timestamp: 20, speaker: "speaker_0", speakerName: "Dan" },
    {
      text: "mine",
      source: "system",
      timestamp: 30,
      speaker: "speaker_0",
      speakerName: "Kept",
      speakerStatus: "locked",
      speakerLocked: true,
    },
  ];
  const diarizeCalls = [];
  const replaced = [];
  const handlers = handlersFor({
    transcript,
    clusters: [
      { start: 9, end: 15, speaker: "speaker_00" },
      { start: 19, end: 25, speaker: "speaker_01" },
    ],
    diarizeCalls,
    replaced,
  });

  const result = await handlers._rediarizeMeetingNote(54, 3);

  assert.equal(result.success, true);
  // Three people with you on the mic: two remote clusters.
  assert.equal(diarizeCalls[0].numSpeakers, 2);
  const [mic, first, second, locked] = result.segments;
  assert.equal(mic.speaker, "you");
  assert.equal(first.speaker, "speaker_0");
  assert.equal(second.speaker, "speaker_1");
  // The old cluster's name is dropped; a hand-assigned line keeps its own.
  assert.equal(first.speakerName, undefined);
  assert.equal(second.speakerName, undefined);
  assert.equal(locked.speakerName, "Kept");
  assert.deepEqual(
    replaced.map(({ noteId }) => noteId),
    [54]
  );
});

test("rows saved without diarization are placed on the audio's timeline", async () => {
  archive(55);
  const handlers = handlersFor({
    transcript: [
      { text: "early", source: "system", timestamp: STARTED_AT + 5000 },
      { text: "late", source: "system", timestamp: STARTED_AT + 60000 },
    ],
    clusters: [
      { start: 0, end: 30, speaker: "speaker_00" },
      { start: 50, end: 70, speaker: "speaker_01" },
    ],
  });

  const result = await handlers._rediarizeMeetingNote(55, 3);

  assert.deepEqual(
    result.segments.map(({ timestamp, speaker }) => [timestamp, speaker]),
    [
      [5, "speaker_0"],
      [60, "speaker_1"],
    ]
  );
});

test("refuses notes without audio or with several sessions, and an empty result", async () => {
  const transcript = [{ text: "x", source: "system", timestamp: 1 }];
  const replaced = [];

  assert.deepEqual(await handlersFor({ transcript })._rediarizeMeetingNote(60, 3), {
    success: false,
    code: "NO_AUDIO",
  });

  archive(61);
  archive(61, STARTED_AT + 3600000);
  assert.deepEqual(await handlersFor({ transcript })._rediarizeMeetingNote(61, 3), {
    success: false,
    code: "MULTIPLE_SESSIONS",
  });

  archive(62);
  assert.deepEqual(
    await handlersFor({ transcript, clusters: [], replaced })._rediarizeMeetingNote(62, 3),
    { success: false, code: "FAILED" }
  );
  // A failed run leaves the note's speaker names alone.
  assert.deepEqual(replaced, []);
});
