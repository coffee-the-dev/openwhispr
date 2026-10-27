process.env.TZ = "UTC";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-files-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const { MarkdownMirror } = require("../../src/helpers/markdownMirror");
const { NoteFilesSync, FORMAT_VERSION } = require("../../src/helpers/noteFilesSync");
const format = require("../../src/helpers/noteExportFormat");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function setup(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-files-db-"));
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-files-export-"));
  t.after(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(exportDir, { recursive: true, force: true });
  });
  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
  t.after(() => db.db?.close());
  const sync = new NoteFilesSync({
    databaseManager: db,
    mirror: new MarkdownMirror(),
    stateFilePath: path.join(userDataDir, "note-files-state.json"),
    debounceMs: 60_000,
    watch: false,
  });
  sync.enable(exportDir, { baseTag: "openwhispr" });
  return { db, sync, exportDir, meetingsDir: path.join(exportDir, "Meetings") };
}

const read = (dir) =>
  Object.fromEntries(
    (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((f) => [
      f,
      fs.readFileSync(path.join(dir, f), "utf8"),
    ])
  );

test("database writes flow into the mirror, including speaker relabels", (t) => {
  const env = setup(t);
  if (!env) return;
  const { db, sync, meetingsDir } = env;

  const { note } = db.saveNote("Standup", "raw", "meeting");
  db.updateNote(note.id, {
    transcript: JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Morning." }]),
  });
  sync.flush();
  const files = Object.keys(read(meetingsDir));
  assert.equal(files.length, 2);
  const transcriptFile = files.find((f) => f.endsWith("(transcript).md"));
  assert.match(read(meetingsDir)[transcriptFile], /\*\*Speaker 1\*\*/);

  db.setSpeakerMapping(note.id, "speaker_0", null, "Grace Hopper");
  sync.flush();
  const relabeled = read(meetingsDir)[transcriptFile];
  assert.match(relabeled, /\*\*Grace Hopper\*\*/);
  assert.match(relabeled, /participants:\n {2}- Grace Hopper\n/);

  db.deleteNote(note.id);
  sync.flush();
  assert.deepEqual(read(meetingsDir), {});
});

test("renaming or deleting a folder moves or removes only owned files", (t) => {
  const env = setup(t);
  if (!env) return;
  const { db, sync, exportDir } = env;

  const { folder } = db.createFolder("Research");
  const { note } = db.saveNote("Sources", "body", "personal", null, null, folder.id);
  sync.flush();
  assert.equal(Object.keys(read(path.join(exportDir, "Research"))).length, 1);

  db.renameFolder(folder.id, "Archive");
  sync.flush();
  assert.equal(fs.existsSync(path.join(exportDir, "Research")), false);
  const archived = read(path.join(exportDir, "Archive"));
  assert.match(Object.values(archived)[0], /folder: Archive/);

  fs.writeFileSync(path.join(exportDir, "Archive", "mine.md"), "user file", "utf8");
  db.deleteFolder(folder.id);
  sync.flush();
  assert.deepEqual(read(path.join(exportDir, "Archive")), { "mine.md": "user file" });
  assert.equal(db.getNote(note.id), null);
});

test("changes are ignored while disabled and a format upgrade triggers a rebuild", (t) => {
  const env = setup(t);
  if (!env) return;
  const { db, sync, exportDir, meetingsDir } = env;

  sync.disable();
  const { note } = db.saveNote("Offline", "", "meeting");
  sync.flush();
  assert.deepEqual(read(meetingsDir), {});

  const statePath = path.join(userDataDir, "note-files-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ formatVersion: 1, basePath: exportDir }));
  sync.enable(exportDir, { skipRebuild: true });
  assert.equal(Object.keys(read(meetingsDir)).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).formatVersion, FORMAT_VERSION);

  db.updateNote(note.id, { title: "Online" });
  sync.flush();
  assert.match(Object.keys(read(meetingsDir))[0], / Online\.md$/);
});

// Writes the files another computer sharing the folder would export,
// replacing (renaming) the copy it wrote before.
function writeForeignExport(exportDir, note, folderName) {
  const dir = path.join(exportDir, folderName);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    if (text.includes(`openwhispr_uid: ${note.client_note_id}\n`)) fs.rmSync(path.join(dir, file));
  }
  const stem = format.buildFileStem(note);
  const ctx = { folderName };
  fs.writeFileSync(
    path.join(dir, format.noteFileName(stem)),
    format.buildNoteMarkdown(note, ctx, stem)
  );
  fs.writeFileSync(
    path.join(dir, format.transcriptFileName(stem)),
    format.buildTranscriptMarkdown(note, ctx, stem)
  );
}

test("notes another computer exported are imported, kept current, and stay deleted", (t) => {
  const env = setup(t);
  if (!env) return;
  const { db, sync, exportDir } = env;
  const researchDir = path.join(exportDir, "Research");
  const foreign = {
    id: 900,
    client_note_id: "laptop-note",
    title: "Vendor call",
    note_type: "meeting",
    content: "typed on the laptop",
    enhanced_content: "## Summary\n- Signed",
    created_at: "2026-10-01 09:00:00",
    updated_at: "2026-10-01 10:00:00",
    transcript: JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text: "Deal." }]),
  };
  writeForeignExport(exportDir, foreign, "Research");
  const exportedFiles = read(researchDir);

  assert.equal(sync.importFromFiles().created.length, 1);
  const imported = db.getNoteByClientNoteId("laptop-note");
  assert.notEqual(imported.id, 900);
  assert.equal(imported.updated_at, "2026-10-01 10:00:00");
  assert.equal(imported.enhanced_content, "## Summary\n- Signed");
  assert.equal(imported.content, "typed on the laptop");
  assert.equal(db.getFolders().find((f) => f.id === imported.folder_id)?.name, "Research");
  sync.flush();
  assert.deepEqual(read(researchDir), exportedFiles, "an import never rewrites its source files");
  assert.equal(sync.importFromFiles().created.length, 0);

  // A local edit rewrites the same files, whatever id the other computer used.
  db.updateNote(imported.id, { content: "edited here" });
  sync.flush();
  const rewritten = read(researchDir);
  assert.deepEqual(Object.keys(rewritten).sort(), Object.keys(exportedFiles).sort());
  assert.match(Object.values(rewritten).join("\n"), new RegExp(`openwhispr_id: ${imported.id}\n`));

  // Only a file updated after the note replaces what changed.
  writeForeignExport(
    exportDir,
    { ...foreign, title: "Stale", updated_at: "2026-10-02 00:00:00" },
    "Research"
  );
  assert.equal(sync.importFromFiles().updated.length, 0);
  assert.equal(db.getNote(imported.id).title, "Vendor call");
  const newer = {
    ...foreign,
    content: "edited here",
    title: "Vendor call (signed)",
    updated_at: "2099-01-01 00:00:00",
  };
  writeForeignExport(exportDir, newer, "Research");
  assert.equal(sync.importFromFiles().updated.length, 1);
  const updated = db.getNote(imported.id);
  assert.equal(updated.title, "Vendor call (signed)");
  assert.equal(updated.content, "edited here");
  assert.equal(updated.updated_at, "2099-01-01 00:00:00");

  // Deleted here: its copy elsewhere comes back only if it changed afterwards.
  db.deleteNote(imported.id);
  sync.flush();
  writeForeignExport(exportDir, { ...foreign, updated_at: "2026-10-03 00:00:00" }, "Research");
  assert.equal(sync.importFromFiles().created.length, 0);
  writeForeignExport(exportDir, { ...foreign, updated_at: "2099-02-01 00:00:00" }, "Research");
  assert.equal(sync.importFromFiles().created.length, 1);
});
