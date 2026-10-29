const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { convertToMp3 } = require("./ffmpegUtils");

// Copy of the audio a meeting's speaker detection ran on — system audio for a
// call, the room mic for an in-person or speakerphone recording — so it can be
// diarized again later. Kept under Settings > Privacy > Audio Retention like
// dictation audio. One MP3 per recording session, named after its note so
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

const readArchive = async (dir) => {
  try {
    return (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".mp3"));
  } catch {
    return [];
  }
};

// Inverse of fileStamp: "2026-10-06T12-31-38-000Z" -> epoch ms.
const parseFileStamp = (stamp) => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : null;
};

// One entry per recording session of the note, oldest first.
async function listMeetingAudioForNote(noteId, { dir = getMeetingAudioDir() } = {}) {
  if (noteId == null) return [];
  const prefix = notePrefix(noteId);
  return (await readArchive(dir))
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({
      filePath: path.join(dir, name),
      startedAt: parseFileStamp(name.slice(prefix.length, -".mp3".length)),
    }))
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

async function deleteMeetingAudioForNote(noteId, { dir = getMeetingAudioDir() } = {}) {
  const owned = await listMeetingAudioForNote(noteId, { dir });
  await Promise.all(owned.map(({ filePath }) => fs.promises.unlink(filePath).catch(() => {})));
  return owned.length;
}

// Same rule as dictation audio: a file older than the retention period goes.
async function deleteExpiredMeetingAudio(
  retentionDays,
  { dir = getMeetingAudioDir(), now = Date.now() } = {}
) {
  const cutoffMs = now - retentionDays * 86400000;
  let deleted = 0;
  for (const name of await readArchive(dir)) {
    const filePath = path.join(dir, name);
    try {
      if ((await fs.promises.stat(filePath)).mtimeMs < cutoffMs) {
        await fs.promises.unlink(filePath);
        deleted += 1;
      }
    } catch {
      // Gone already, or unreadable: the next sweep tries again.
    }
  }
  return deleted;
}

async function deleteAllMeetingAudio({ dir = getMeetingAudioDir() } = {}) {
  const names = await readArchive(dir);
  await Promise.all(names.map((name) => fs.promises.unlink(path.join(dir, name)).catch(() => {})));
  return names.length;
}

async function getMeetingAudioUsage({ dir = getMeetingAudioDir() } = {}) {
  let fileCount = 0;
  let totalBytes = 0;
  for (const name of await readArchive(dir)) {
    try {
      totalBytes += (await fs.promises.stat(path.join(dir, name))).size;
      fileCount += 1;
    } catch {
      // Skip files that can't be stat'd
    }
  }
  return { fileCount, totalBytes };
}

module.exports = {
  getMeetingAudioDir,
  archiveMeetingAudio,
  listMeetingAudioForNote,
  deleteMeetingAudioForNote,
  deleteExpiredMeetingAudio,
  deleteAllMeetingAudio,
  getMeetingAudioUsage,
};
