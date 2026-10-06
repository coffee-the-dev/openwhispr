const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  archiveMeetingAudio,
  deleteMeetingAudioForNote,
} = require("../../src/helpers/meetingAudioArchive");
Module._load = originalLoad;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ow-meeting-audio-test-"));
const copyConvert = async (input, output) => fs.promises.copyFile(input, output);

test("archives the diarization audio under the note's name", async () => {
  const dir = tempDir();
  const wav = path.join(dir, "input.wav");
  fs.writeFileSync(wav, "RIFF");

  const target = await archiveMeetingAudio(wav, {
    noteId: 25,
    startedAt: Date.UTC(2026, 9, 6, 12, 31, 38),
    dir,
    convert: copyConvert,
  });

  assert.equal(path.basename(target), "note-25-2026-10-06T12-31-38-000Z.mp3");
  assert.equal(fs.readFileSync(target, "utf8"), "RIFF");
});

test("deleting a note removes only that note's audio", async () => {
  const dir = tempDir();
  for (const name of ["note-1-a.mp3", "note-1-b.mp3", "note-12-a.mp3", "meeting-a.mp3"]) {
    fs.writeFileSync(path.join(dir, name), "");
  }

  assert.equal(await deleteMeetingAudioForNote(1, { dir }), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["meeting-a.mp3", "note-12-a.mp3"]);
});

test("deleting audio for a note without an archive folder is a no-op", async () => {
  const missing = path.join(os.tmpdir(), `ow-meeting-audio-missing-${process.pid}`);
  assert.equal(await deleteMeetingAudioForNote(3, { dir: missing }), 0);
});
