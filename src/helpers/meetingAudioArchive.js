const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { convertToMp3 } = require("./ffmpegUtils");

// Opt-in copy of the audio a meeting's speaker detection ran on — system audio
// for a call, the room mic for an in-person or speakerphone recording — so it
// can be diarized again later. One MP3 per meeting, named after its note so
// deleting the note can remove it.

const getMeetingAudioDir = () => path.join(app.getPath("userData"), "meeting-audio");

// The trailing dash keeps note 1 from matching note 12's files.
const notePrefix = (noteId) => `note-${noteId}-`;

const fileStamp = (startedAt) =>
  new Date(Number.isFinite(startedAt) ? startedAt : Date.now()).toISOString().replace(/[:.]/g, "-");

async function archiveMeetingAudio(
  wavPath,
  { noteId = null, startedAt = null, dir = getMeetingAudioDir(), convert = convertToMp3 } = {}
) {
  await fs.promises.mkdir(dir, { recursive: true });
  const prefix = noteId != null ? notePrefix(noteId) : "meeting-";
  const target = path.join(dir, `${prefix}${fileStamp(startedAt)}.mp3`);
  await convert(wavPath, target);
  return target;
}

async function deleteMeetingAudioForNote(noteId, { dir = getMeetingAudioDir() } = {}) {
  if (noteId == null) return 0;
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  const prefix = notePrefix(noteId);
  const owned = names.filter((name) => name.startsWith(prefix));
  await Promise.all(owned.map((name) => fs.promises.unlink(path.join(dir, name)).catch(() => {})));
  return owned.length;
}

module.exports = { getMeetingAudioDir, archiveMeetingAudio, deleteMeetingAudioForNote };
