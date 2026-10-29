const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { convertToMp3 } = require("./ffmpegUtils");

// Copies of a meeting's two captures — system audio and the room mic — so its
// speakers can be detected again later. The track speaker detection ran on is
// named by its source (`-system` / `-mic`), the other gets `-alt` and starts at
// the same instant. Kept under Settings > Privacy > Audio Retention like
// dictation audio, one session per start stamp, named after its note so
// deleting the note can remove it. Older builds kept one unsuffixed file.

const getMeetingAudioDir = () => path.join(app.getPath("userData"), "meeting-audio");

// The trailing dash keeps note 1 from matching note 12's files.
const notePrefix = (noteId) => `note-${noteId}-`;

const fileStamp = (startedAt) =>
  new Date(Number.isFinite(startedAt) ? startedAt : Date.now()).toISOString().replace(/[:.]/g, "-");

async function archiveMeetingAudio(
  wavPath,
  {
    noteId = null,
    startedAt = null,
    track = null,
    dir = getMeetingAudioDir(),
    convert = convertToMp3,
  } = {}
) {
  await fs.promises.mkdir(dir, { recursive: true });
  const prefix = noteId != null ? notePrefix(noteId) : "meeting-";
  const suffix = track ? `-${track}` : "";
  const target = path.join(dir, `${prefix}${fileStamp(startedAt)}${suffix}.mp3`);
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

const TRACK_SUFFIX = /-(mic|system)(-alt)?$/;

// One entry per recording session of the note, oldest first: the track speaker
// detection ran on (`source` null for older single-file archives) and the other
// capture, if kept.
async function listMeetingAudioForNote(noteId, { dir = getMeetingAudioDir() } = {}) {
  if (noteId == null) return [];
  const prefix = notePrefix(noteId);
  const sessions = new Map();
  for (const name of await readArchive(dir)) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length, -".mp3".length);
    const match = TRACK_SUFFIX.exec(rest);
    const stamp = match ? rest.slice(0, match.index) : rest;
    const track = { filePath: path.join(dir, name), source: match?.[1] ?? null };
    const session = sessions.get(stamp) ?? { startedAt: parseFileStamp(stamp), alternate: null };
    if (match?.[2]) session.alternate = track;
    else Object.assign(session, track);
    sessions.set(stamp, session);
  }
  return [...sessions.values()]
    .map((session) =>
      // A session whose main track was never written falls back to the other.
      session.filePath ? session : { ...session, ...session.alternate, alternate: null }
    )
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

async function deleteMeetingAudioForNote(noteId, { dir = getMeetingAudioDir() } = {}) {
  const files = (await listMeetingAudioForNote(noteId, { dir })).flatMap((session) =>
    [session.filePath, session.alternate?.filePath].filter(Boolean)
  );
  await Promise.all(files.map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
  return files.length;
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
