const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-container-db-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-container-db-"));
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

function privateSpace(db) {
  return db.getSpace(db.getPrivateSpaceId());
}

test("container scope migration is idempotent across launches", (t) => {
  const db = createDb(t);
  if (!db) return;

  const columns = db.db.pragma("table_info('agent_conversations')").map((col) => col.name);
  assert.ok(columns.includes("space_id"));
  assert.ok(columns.includes("folder_id"));

  db.db.close();

  const db2 = new DatabaseManager();
  const indexes = db2.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_conversations'"
    )
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_agent_conversations_container"));
});

test("createAgentConversation stores container scope", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = privateSpace(db);
  const folder = db.createFolder("Docs", space.id).folder;

  const folderConv = db.createAgentConversation("Docs", null, space.id, folder.id);
  assert.equal(folderConv.space_id, space.id);
  assert.equal(folderConv.folder_id, folder.id);

  const spaceConv = db.createAgentConversation("Personal", null, space.id);
  assert.equal(spaceConv.space_id, space.id);
  assert.equal(spaceConv.folder_id, null);

  const globalConv = db.createAgentConversation("Global");
  assert.equal(globalConv.space_id, null);
  assert.equal(globalConv.folder_id, null);
  assert.equal(globalConv.note_id, null);
});

test("getConversationsForContainer separates folder and space-root scopes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = privateSpace(db);
  const folder = db.createFolder("Docs", space.id).folder;

  const folderConv = db.createAgentConversation("Folder chat", null, space.id, folder.id);
  const spaceConv = db.createAgentConversation("Space chat", null, space.id);
  db.createAgentConversation("Global chat");
  db.addAgentMessage(folderConv.id, "user", "hello");

  const folderList = db.getConversationsForContainer(space.id, folder.id);
  assert.equal(folderList.length, 1);
  assert.equal(folderList[0].id, folderConv.id);
  assert.equal(folderList[0].message_count, 1);

  const spaceList = db.getConversationsForContainer(space.id, null);
  assert.equal(spaceList.length, 1, "space root must exclude folder-scoped conversations");
  assert.equal(spaceList[0].id, spaceConv.id);
  assert.equal(spaceList[0].message_count, 0);
});

test("deleteAgentConversation removes the conversation and its messages", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = privateSpace(db);

  const conv = db.createAgentConversation("Doomed", null, space.id);
  db.addAgentMessage(conv.id, "user", "hello");

  assert.deepEqual(db.deleteAgentConversation(conv.id), { success: true });
  assert.equal(db.getConversationsForContainer(space.id, null).length, 0);
  assert.equal(db.getAgentConversation(conv.id), null);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id = ?").get(conv.id)
      .n,
    0
  );
});

test("global conversation lists and search exclude space and folder chats", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = privateSpace(db);
  const folder = db.createFolder("Docs", space.id).folder;
  const note = db.saveNote("Roadmap source", "body").note;

  const global = db.createAgentConversation("Roadmap global");
  const archivedGlobal = db.createAgentConversation("Roadmap archived");
  const noteScoped = db.createAgentConversation("Roadmap note", note.id);
  const spaceScoped = db.createAgentConversation("Roadmap space", null, space.id);
  const folderScoped = db.createAgentConversation("Roadmap folder", null, space.id, folder.id);
  db.archiveAgentConversation(archivedGlobal.id);
  db.addAgentMessage(global.id, "user", "roadmap");
  db.addAgentMessage(noteScoped.id, "user", "roadmap");
  db.addAgentMessage(spaceScoped.id, "user", "roadmap");
  db.addAgentMessage(folderScoped.id, "user", "roadmap");

  assert.deepEqual(
    new Set(db.getAgentConversations().map((conversation) => conversation.id)),
    new Set([global.id, archivedGlobal.id, noteScoped.id])
  );
  assert.deepEqual(
    new Set(db.getAgentConversationsWithPreview().map((conversation) => conversation.id)),
    new Set([noteScoped.id, global.id])
  );
  assert.deepEqual(
    db.getAgentConversationsWithPreview(50, 0, true).map((conversation) => conversation.id),
    [archivedGlobal.id]
  );
  assert.deepEqual(
    new Set(db.searchAgentConversations("roadmap").map((conversation) => conversation.id)),
    new Set([global.id, noteScoped.id])
  );
  assert.equal(db.getConversationsForContainer(space.id, null)[0].id, spaceScoped.id);
  assert.equal(db.getConversationsForContainer(space.id, folder.id)[0].id, folderScoped.id);
});

test("searchNotes filters by folder", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = privateSpace(db);
  const folder = db.createFolder("Docs", space.id).folder;

  db.saveNote("Roadmap planning", "quarterly roadmap", "personal", null, null, folder.id, space.id);
  db.saveNote("Roadmap ideas", "more roadmap", "personal", null, null, null, space.id);

  const spaceHits = db.searchNotes("roadmap", 10, space.id);
  assert.equal(spaceHits.length, 2);

  const folderHits = db.searchNotes("roadmap", 10, space.id, folder.id);
  assert.equal(folderHits.length, 1);
  assert.equal(folderHits[0].folder_id, folder.id);
});

test("getNotesForSpace includes foldered notes, unlike the root-only getNotes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = privateSpace(db);
  const folder = db.createFolder("Docs", space.id).folder;

  const rootNote = db.saveNote("Root", "", "personal", null, null, null, space.id).note;
  const folderNote = db.saveNote("Foldered", "", "personal", null, null, folder.id, space.id).note;
  db.deleteNote(folderNote.id);
  const keptNote = db.saveNote("Kept", "", "personal", null, null, folder.id, space.id).note;

  // saveNote with no folder files the note into the default Personal folder.
  const rootOnly = db.getNotes(null, 50, null, space.id);
  assert.deepEqual(rootOnly, []);

  const all = db.getNotesForSpace(space.id);
  assert.deepEqual(new Set(all.map((n) => n.id)), new Set([rootNote.id, keptNote.id]));
});

test("getNoteIdsInFolder excludes deleted notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = privateSpace(db);
  const folder = db.createFolder("Docs", space.id).folder;

  const kept = db.saveNote("Kept", "", "personal", null, null, folder.id, space.id).note;
  const removed = db.saveNote("Removed", "", "personal", null, null, folder.id, space.id).note;
  db.deleteNote(removed.id);

  assert.deepEqual(db.getNoteIdsInFolder(folder.id), [kept.id]);
});

test("getNoteIdsInScope validates vector candidates against the current SQLite scope", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = privateSpace(db);
  const docs = db.createFolder("Docs", space.id).folder;
  const other = db.createFolder("Other", space.id).folder;

  const filed = db.saveNote("Filed", "", "personal", null, null, docs.id, space.id).note;
  const elsewhere = db.saveNote("Elsewhere", "", "personal", null, null, other.id, space.id).note;
  const deleted = db.saveNote("Deleted", "", "personal", null, null, docs.id, space.id).note;
  db.deleteNote(deleted.id);

  assert.deepEqual(db.getNoteIdsInScope(space.id, docs.id), [filed.id]);
  assert.deepEqual(db.getNoteIdsInScope(space.id + 1000), []);
  assert.deepEqual(
    db.getNoteIdsInScope(space.id, docs.id, [filed.id, elsewhere.id, deleted.id]),
    [filed.id],
    "stale vector candidates are filtered by live local scope"
  );
});

test("deleteNote removes the note with its chats and speaker rows", (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Meeting", "body").note;
  const conv = db.createAgentConversation("Note chat", note.id);
  db.addAgentMessage(conv.id, "user", "hello");
  db.db
    .prepare(
      "INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, 'S1', 'Ada')"
    )
    .run(note.id);
  const globalConv = db.createAgentConversation("Global");

  assert.deepEqual(db.deleteNote(note.id), { success: true, id: note.id });

  assert.equal(db.getNote(note.id), null);
  assert.equal(db.getAgentConversation(conv.id), null);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id = ?").get(conv.id)
      .n,
    0
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM speaker_mappings WHERE note_id = ?").get(note.id).n,
    0
  );
  assert.ok(db.getAgentConversation(globalConv.id), "unscoped conversations are untouched");
});

test("deleteFolder removes its notes, their chats, and the folder's own chats", (t) => {
  const db = createDb(t);
  if (!db) return;
  const space = privateSpace(db);
  const folder = db.createFolder("Docs", space.id).folder;
  const note = db.saveNote("Filed", "body", "personal", null, null, folder.id, space.id).note;
  const noteConv = db.createAgentConversation("Note chat", note.id);
  const folderConv = db.createAgentConversation("Folder chat", null, space.id, folder.id);
  db.addAgentMessage(folderConv.id, "user", "hello");
  const spaceConv = db.createAgentConversation("Space chat", null, space.id);

  const result = db.deleteFolder(folder.id);
  assert.deepEqual(result, { success: true, id: folder.id, noteIds: [note.id], name: "Docs" });

  assert.equal(db.getNote(note.id), null);
  assert.equal(db.getAgentConversation(noteConv.id), null);
  assert.equal(db.getAgentConversation(folderConv.id), null);
  assert.ok(db.getAgentConversation(spaceConv.id));
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM folders WHERE id = ?").get(folder.id).n, 0);
  assert.equal(db.createFolder("Docs", space.id).success, true, "the name is free again");
});

test("default folders cannot be deleted", (t) => {
  const db = createDb(t);
  if (!db) return;
  const personal = db.getFolders().find((folder) => folder.name === "Personal");
  assert.deepEqual(db.deleteFolder(personal.id), {
    success: false,
    error: "Cannot delete default folders",
  });
});
