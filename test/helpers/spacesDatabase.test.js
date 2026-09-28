const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spaces-db-"));
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

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spaces-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("spaces migration is idempotent across launches", (t) => {
  const db = createDb(t);
  if (!db) return;

  const foldersSql = db.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
    .get().sql;
  assert.ok(
    !foldersSql.includes("UNIQUE"),
    "folders rebuild should drop the UNIQUE(name) constraint"
  );
  db.db.close();

  const db2 = new DatabaseManager();
  const rerunSql = db2.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
    .get().sql;
  assert.equal(rerunSql, foldersSql, "second launch must not rebuild folders again");

  const noteColumns = db2.db.pragma("table_info('notes')").map((col) => col.name);
  assert.ok(noteColumns.includes("space_id"));
  const folderColumns = db2.db.pragma("table_info('folders')").map((col) => col.name);
  assert.ok(folderColumns.includes("space_id"));

  const indexes = db2.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'folders'")
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_folders_client_folder_id"));
  assert.ok(indexes.includes("idx_folders_space_legacy_name"));
  assert.ok(indexes.includes("idx_folders_space_account_name"));

  const privates = db2.db
    .prepare("SELECT COUNT(*) as count FROM spaces WHERE kind = 'private'")
    .get();
  assert.equal(privates.count, 1);
});

test("pre-migration rows are backfilled into the private space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  assert.ok(privateId);

  for (const folder of db.getFolders()) {
    assert.equal(folder.space_id, privateId);
  }
  for (const note of db.getNotes()) {
    assert.equal(note.space_id, privateId);
  }

  // Simulate rows written before the spaces migration existed.
  db.db
    .prepare("INSERT INTO folders (name, client_folder_id) VALUES ('Legacy', 'legacy-folder')")
    .run();
  db.db
    .prepare(
      "INSERT INTO notes (title, content, client_note_id) VALUES ('Legacy', '', 'legacy-note')"
    )
    .run();
  db.db.close();

  const db2 = new DatabaseManager();
  const legacyFolder = db2.db
    .prepare("SELECT * FROM folders WHERE client_folder_id = 'legacy-folder'")
    .get();
  assert.equal(legacyFolder.space_id, privateId);
  const legacyNote = db2.db
    .prepare("SELECT * FROM notes WHERE client_note_id = 'legacy-note'")
    .get();
  assert.equal(legacyNote.space_id, privateId);
});

test("folder names are unique within the space", (t) => {
  const db = createDb(t);
  if (!db) return;

  const created = db.createFolder("Projects");
  assert.ok(created.success);
  assert.equal(created.folder.space_id, db.getPrivateSpaceId());
  assert.equal(db.createFolder("Projects").success, false);

  const other = db.createFolder("Other").folder;
  assert.equal(db.renameFolder(other.id, "Projects").success, false);

  assert.ok(db.deleteFolder(created.folder.id).success);
  assert.ok(db.createFolder("Projects").success, "a deleted folder frees its name");
});

test("updateNote forces space_id to follow folder_id (D2)", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const folder = db.createFolder("Docs").folder;

  const { note } = db.saveNote("Move me", "content");
  assert.equal(note.space_id, privateId);

  const moved = db.updateNote(note.id, { folder_id: folder.id });
  assert.equal(moved.note.folder_id, folder.id);
  assert.equal(moved.note.space_id, privateId);

  const detached = db.updateNote(note.id, { folder_id: null, space_id: privateId });
  assert.equal(detached.note.folder_id, null);
  assert.equal(detached.note.space_id, privateId);

  assert.deepEqual(db.updateNote(note.id, { folder_id: 9999 }), {
    success: false,
    error: "Folder not found",
  });
  assert.deepEqual(db.updateNote(note.id, { space_id: 9999 }), {
    success: false,
    error: "Space not found",
  });
});

test("updateNote ignores fields outside the local note shape", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { note } = db.saveNote("Title", "content");

  const updated = db.updateNote(note.id, { title: "Renamed", cloud_id: "x", sync_status: "y" });
  assert.equal(updated.note.title, "Renamed");
  assert.equal(updated.note.cloud_id, null);
  assert.deepEqual(db.updateNote(note.id, { cloud_id: "x" }), { success: false });
});

test("saveNote files notes into the matching default folder", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();

  const meetingsFolder = db.getMeetingsFolder();
  assert.ok(meetingsFolder);
  const personalFolder = db.getFolders().find((folder) => folder.name === "Personal");

  const meeting = db.saveNote("Standup", "notes", "meeting").note;
  assert.equal(meeting.folder_id, meetingsFolder.id);
  assert.equal(meeting.space_id, privateId);

  const personal = db.saveNote("Doc", "body").note;
  assert.equal(personal.folder_id, personalFolder.id);
  assert.equal(personal.space_id, privateId);
});

test("getNotes with spaceId and no folderId lists only the space's root notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const folder = db.createFolder("Docs").folder;
  const rootNote = db.saveNote("Root", "body").note;
  db.updateNote(rootNote.id, { folder_id: null, space_id: privateId });
  db.saveNote("Filed", "body", "personal", null, null, folder.id);

  assert.deepEqual(
    db.getNotes(null, 50, null, privateId).map((n) => n.id),
    [rootNote.id]
  );

  const folderNotes = db.getNotes(null, 50, folder.id);
  assert.equal(folderNotes.length, 1);
  assert.equal(folderNotes[0].title, "Filed");
});

test("space-root notes keep folder_id NULL across relaunches", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const privateRoot = db.saveNote("Mine", "body").note;
  db.updateNote(privateRoot.id, { folder_id: null, space_id: privateId });
  const snapshot = db.db
    .prepare("SELECT id, folder_id, space_id, updated_at FROM notes WHERE id = ?")
    .get(privateRoot.id);
  db.db.close();

  const db2 = new DatabaseManager();
  const relaunched = db2.db
    .prepare("SELECT id, folder_id, space_id, updated_at FROM notes WHERE id = ?")
    .get(privateRoot.id);
  assert.deepEqual(
    relaunched,
    snapshot,
    "relaunch must not backfill space-root notes into a folder"
  );
});

test("deletes clean speaker rows", (t) => {
  const db = createDb(t);
  if (!db) return;
  const seedSpeakerRows = (noteId) => {
    db.db
      .prepare(
        "INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, 'spk_0', 'Alice')"
      )
      .run(noteId);
    db.db
      .prepare(
        "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, 'spk_0', ?)"
      )
      .run(noteId, Buffer.from(new Float32Array([0.1, 0.2]).buffer));
  };
  const residue = (noteId) =>
    db.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM speaker_mappings WHERE note_id = ?) + (SELECT COUNT(*) FROM note_speaker_embeddings WHERE note_id = ?) as count"
      )
      .get(noteId, noteId).count;

  const solo = db.saveNote("Solo", "body").note;
  seedSpeakerRows(solo.id);
  assert.ok(db.deleteNote(solo.id).success);
  assert.equal(residue(solo.id), 0);
  assert.equal(db.deleteNote(solo.id).success, false, "a second delete finds nothing");

  const folder = db.createFolder("Filed").folder;
  const filed = db.saveNote("Filed", "body", "personal", null, null, folder.id).note;
  seedSpeakerRows(filed.id);
  assert.ok(db.deleteFolder(folder.id).success);
  assert.equal(residue(filed.id), 0);
});

// Only older builds queued purges (for team spaces); the lifecycle still drains them.
test("pending vector purges persist across relaunches until cleared", (t) => {
  const db = createDb(t);
  if (!db) return;
  const queue = db.db.prepare("INSERT OR IGNORE INTO pending_vector_purges (space_id) VALUES (?)");
  queue.run(42);
  queue.run(42);
  queue.run(7);
  assert.deepEqual(
    db
      .getPendingVectorPurges()
      .map((row) => row.space_id)
      .sort((a, b) => a - b),
    [7, 42]
  );
  db.db.close();

  const db2 = new DatabaseManager();
  assert.equal(db2.getPendingVectorPurges().length, 2, "queue must survive a relaunch");
  db2.clearPendingVectorPurge(42);
  assert.deepEqual(
    db2.getPendingVectorPurges().map((row) => row.space_id),
    [7]
  );
});

test("getFolderNoteCounts attributes space-root notes per space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const privateId = db.getPrivateSpaceId();
  const folder = db.createFolder("Docs").folder;
  db.saveNote("Filed", "body", "personal", null, null, folder.id);
  for (const title of ["Root A", "Root B", "Gone"]) {
    const note = db.saveNote(title, "body").note;
    db.updateNote(note.id, { folder_id: null, space_id: privateId });
    if (title === "Gone") db.deleteNote(note.id);
  }

  const counts = db.getFolderNoteCounts();
  const folderRow = counts.find((c) => c.folder_id === folder.id);
  assert.equal(folderRow.space_id, privateId);
  assert.equal(folderRow.count, 1);

  const rootRow = counts.find((c) => c.folder_id === null && c.space_id === privateId);
  assert.equal(rootRow.count, 2, "space-root notes count per space, excluding deleted notes");
});

test("getSpaces lists the private space", (t) => {
  const db = createDb(t);
  if (!db) return;
  const spaces = db.getSpaces();
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].kind, "private");
  assert.equal(db.getSpace(spaces[0].id).id, spaces[0].id);
});

test("a relaunch purges tombstones left by cloud sync once", (t) => {
  const db = createDb(t);
  if (!db) return;
  const folder = db.createFolder("Old folder").folder;
  const inFolder = db.saveNote("In old folder", "body", "personal", null, null, folder.id).note;
  const liveInFolder = db.saveNote(
    "Live in old folder",
    "body",
    "personal",
    null,
    null,
    folder.id
  ).note;
  const deletedNote = db.saveNote("Deleted", "body").note;
  const liveNote = db.saveNote("Live", "body").note;
  const noteChat = db.createAgentConversation("Deleted note chat", deletedNote.id);
  db.addAgentMessage(noteChat.id, "user", "hello");
  const deletedChat = db.createAgentConversation("Deleted chat");
  const liveChat = db.createAgentConversation("Live chat");
  db.db
    .prepare(
      "INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, 'spk_0', 'Ada')"
    )
    .run(deletedNote.id);
  const deletedTranscription = db.saveTranscription("gone").id;
  const liveTranscription = db.saveTranscription("kept").id;
  db.setDictionary(["Kept", "Gone"]);
  db.setSnippets([
    { trigger: "kept", replacement: "Kept" },
    { trigger: "gone", replacement: "Gone" },
  ]);

  const tombstone = (table, where, ...params) =>
    db.db
      .prepare(`UPDATE ${table} SET deleted_at = '2026-01-01 00:00:00' WHERE ${where}`)
      .run(...params);
  tombstone("notes", "id IN (?, ?)", deletedNote.id, inFolder.id);
  tombstone("folders", "id = ?", folder.id);
  tombstone("agent_conversations", "id = ?", deletedChat.id);
  tombstone("transcriptions", "id = ?", deletedTranscription);
  tombstone("custom_dictionary", "word = 'Gone'");
  tombstone("snippets", "trigger = 'gone'");
  db.db
    .prepare(
      "INSERT INTO optimistic_folder_delete_rows (folder_id, entity_type, entity_id) VALUES (?, 'note', ?)"
    )
    .run(folder.id, inFolder.id);
  db.db.pragma("user_version = 3");
  db.db.close();

  const db2 = new DatabaseManager();
  const ids = (sql) =>
    db2.db
      .prepare(sql)
      .all()
      .map((row) => Object.values(row)[0]);
  assert.equal(db2.db.pragma("user_version", { simple: true }), 4);
  assert.deepEqual(ids("SELECT id FROM notes ORDER BY id"), [liveInFolder.id, liveNote.id]);
  assert.equal(db2.getNote(liveInFolder.id).folder_id, null, "orphans move to the space root");
  assert.equal(
    db2.db.prepare("SELECT COUNT(*) AS n FROM folders WHERE id = ?").get(folder.id).n,
    0
  );
  assert.deepEqual(ids("SELECT id FROM agent_conversations"), [liveChat.id]);
  assert.equal(db2.db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n, 0);
  assert.equal(db2.db.prepare("SELECT COUNT(*) AS n FROM speaker_mappings").get().n, 0);
  assert.deepEqual(ids("SELECT id FROM transcriptions"), [liveTranscription]);
  assert.deepEqual(db2.getDictionary(), ["Kept"]);
  assert.deepEqual(db2.getSnippets(), [{ trigger: "kept", replacement: "Kept" }]);
  assert.equal(
    db2.db.prepare("SELECT COUNT(*) AS n FROM optimistic_folder_delete_rows").get().n,
    0
  );
  db2.db.close();
});

test("folders rebuild succeeds on a legacy DB with notes referencing folders", (t) => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spaces-db-"));
  let legacy;
  try {
    const BetterSqlite = require("better-sqlite3");
    legacy = new BetterSqlite(path.join(userDataDir, "transcriptions.db"));
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }

  // Pre-migration shape: folders still carries the table-level UNIQUE(name)
  // and notes rows reference them. better-sqlite3 enables foreign_keys by
  // default, so the rebuild's DROP TABLE used to throw on exactly this DB.
  legacy.exec(`
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'Untitled Note',
      content TEXT NOT NULL DEFAULT '',
      note_type TEXT NOT NULL DEFAULT 'personal',
      source_file TEXT,
      audio_duration_seconds REAL,
      folder_id INTEGER REFERENCES folders(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO folders (name, is_default, sort_order) VALUES ('Personal', 1, 0), ('Projects', 0, 1);
    INSERT INTO notes (title, content, folder_id) VALUES
      ('Legacy note one', 'body', 1),
      ('Legacy note two', 'body', 2),
      ('Legacy note three', 'body', 2);
  `);
  legacy.close();

  const db = new DatabaseManager();

  const foldersSql = db.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
    .get().sql;
  assert.ok(!foldersSql.includes("UNIQUE"), "rebuild dropped the UNIQUE(name) constraint");
  assert.equal(
    db.db.pragma("foreign_keys", { simple: true }),
    1,
    "foreign key enforcement is restored after the rebuild"
  );

  const privateId = db.getPrivateSpaceId();
  const notes = db.db.prepare("SELECT title, folder_id, space_id FROM notes ORDER BY id").all();
  assert.equal(notes.length, 3, "all legacy notes survive the rebuild");
  assert.deepEqual(
    notes.map((n) => n.folder_id),
    [1, 2, 2],
    "notes keep their folder references"
  );
  assert.ok(
    notes.every((n) => n.space_id === privateId),
    "legacy notes are backfilled into the private space"
  );
  const folders = db.db.prepare("SELECT id, name, space_id FROM folders ORDER BY id").all();
  // init may seed additional defaults (e.g. "Videos"); the legacy folders
  // must survive with their ids intact.
  assert.deepEqual(
    folders.filter((f) => ["Personal", "Projects"].includes(f.name)).map((f) => f.id),
    [1, 2],
    "both legacy folders survive with their ids"
  );
  assert.ok(
    folders.every((f) => f.space_id === privateId),
    "all folders are backfilled into the private space"
  );
  db.db.close();
});
