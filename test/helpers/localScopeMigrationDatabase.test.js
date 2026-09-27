const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: {} };
  return originalLoad.call(this, request, parent, isMain);
};
const DatabaseManager = require("../../src/helpers/database.js");
Module._load = originalLoad;

function createDatabaseManager() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE spaces (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT,
      deleted_at TEXT
    );
    CREATE TABLE space_accounts (
      space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      PRIMARY KEY (space_id, account_id)
    );
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      space_id INTEGER,
      account_id TEXT,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX idx_folders_space_legacy_name ON folders(space_id, name)
      WHERE deleted_at IS NULL AND account_id IS NULL;
    CREATE UNIQUE INDEX idx_folders_space_account_name ON folders(space_id, account_id, name)
      WHERE deleted_at IS NULL AND account_id IS NOT NULL;
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      folder_id INTEGER REFERENCES folders(id),
      space_id INTEGER,
      account_id TEXT,
      deleted_at TEXT
    );
    CREATE TABLE agent_conversations (
      id INTEGER PRIMARY KEY,
      note_id INTEGER,
      space_id INTEGER,
      folder_id INTEGER
    );
    CREATE TABLE optimistic_folder_delete_rows (
      folder_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER
    );
    INSERT INTO spaces (id, kind, name) VALUES (1, 'private', 'Personal'), (2, 'team', 'Acme');
    INSERT INTO space_accounts (space_id, account_id) VALUES (2, 'account-a');
    INSERT INTO folders (id, name, is_default, space_id, account_id, deleted_at) VALUES
      (1, 'Personal', 1, 1, NULL, NULL),
      (2, 'Ideas', 0, 1, NULL, NULL),
      (3, 'Personal', 1, 1, 'account-a', NULL),
      (4, 'Ideas', 0, 1, 'account-a', NULL),
      (5, 'Research', 0, 1, 'account-b', NULL),
      (6, 'Ideas', 0, 2, NULL, NULL),
      (7, 'Old', 0, 1, 'account-a', '2026-01-01');
    INSERT INTO notes (id, title, folder_id, space_id, account_id) VALUES
      (1, 'guest', 1, 1, NULL),
      (2, 'account personal', 3, 1, 'account-a'),
      (3, 'account ideas', 4, 1, 'account-a'),
      (4, 'other account', 5, 1, 'account-b'),
      (5, 'team', 6, 2, NULL),
      (6, 'team root', NULL, 2, NULL),
      (7, 'account root', NULL, 1, 'account-a');
    INSERT INTO agent_conversations (id, note_id, space_id, folder_id) VALUES
      (1, NULL, 1, 3),
      (2, NULL, 2, 6),
      (3, 5, NULL, NULL);
    INSERT INTO optimistic_folder_delete_rows (folder_id, entity_type, entity_id) VALUES
      (3, 'note', 2);
  `);
  sqlite.transaction =
    (fn) =>
    (...args) => {
      sqlite.exec("BEGIN");
      try {
        const result = fn(...args);
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    };

  const manager = Object.create(DatabaseManager.prototype);
  manager.db = sqlite;
  return { manager, sqlite };
}

test("re-home moves every account and team row into the local private space", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());

  manager._rehomeAccountScopedRowsToLocal();

  const notes = sqlite
    .prepare("SELECT id, folder_id, space_id, account_id FROM notes ORDER BY id")
    .all();
  assert.equal(notes.length, 7, "no note is lost");
  for (const note of notes) {
    assert.equal(note.space_id, 1);
    assert.equal(note.account_id, null);
  }
  const folderOf = Object.fromEntries(notes.map((note) => [note.id, note.folder_id]));
  assert.equal(folderOf[2], 1, "an account's default Personal merges into the local one");
  assert.equal(folderOf[3], 4);
  assert.equal(folderOf[5], 6);
  assert.equal(folderOf[6], null);

  const folders = sqlite
    .prepare("SELECT id, name, space_id, account_id, deleted_at FROM folders ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(
    folders.map((folder) => [folder.id, folder.name]),
    [
      [1, "Personal"],
      [2, "Ideas"],
      [4, "Ideas (Personal)"],
      [5, "Research"],
      [6, "Ideas (Acme)"],
      [7, "Old"],
    ]
  );
  for (const folder of folders) {
    assert.equal(folder.space_id, 1);
    assert.equal(folder.account_id, null);
  }

  const conversations = sqlite
    .prepare("SELECT id, space_id, folder_id FROM agent_conversations ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(conversations, [
    { id: 1, space_id: 1, folder_id: 1 },
    { id: 2, space_id: 1, folder_id: 6 },
    { id: 3, space_id: null, folder_id: null },
  ]);

  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM optimistic_folder_delete_rows").get().n,
    0
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT id, kind FROM spaces")
      .all()
      .map((row) => ({ ...row })),
    [{ id: 1, kind: "private" }]
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM space_accounts").get().n, 0);
});

test("a re-home rerun changes nothing", (t) => {
  const { manager, sqlite } = createDatabaseManager();
  t.after(() => sqlite.close());

  manager._rehomeAccountScopedRowsToLocal();
  const before = sqlite.prepare("SELECT * FROM folders ORDER BY id").all();
  manager._rehomeAccountScopedRowsToLocal();
  assert.deepEqual(sqlite.prepare("SELECT * FROM folders ORDER BY id").all(), before);
});
