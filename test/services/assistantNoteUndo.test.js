const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { UNDO_TTL_MS, initializeNoteUndo } = require("../../src/helpers/noteUndo");

// Real SQLite and the real tool/registry, with only Electron/provider transport stubbed.
test("safe assistant edits and atomic Undo", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-assistant-undo-"));
  const originalLoad = Module._load;
  let database;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === "electron")
        return {
          app: { getPath: () => directory, getAppPath: () => process.cwd(), isReady: () => false },
        };
      return originalLoad.call(this, request, parent, isMain);
    };
    const DatabaseManager = require("../../src/helpers/database.js");
    database = new DatabaseManager();
  } catch (error) {
    // Locally better-sqlite3 is built for Electron's ABI, so a plain `node` run skips (as harness/db.js does).
    if (
      process.env.REQUIRE_DB_TESTS ||
      !/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/.test(String(error))
    ) {
      throw error;
    }
    t.skip("better-sqlite3 native binding is not available for this Node runtime");
    return;
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => {
    database.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async (id) => database.getNote(id),
        updateNote: async (id, updates, options) => database.updateNote(id, updates, options),
        getFolders: async (spaceId) => database.getFolders(spaceId),
        createFolder: async (name, spaceId) => database.createFolder(name, spaceId),
      },
    },
  });
  const vite = await createRendererServer(t);
  const { updateNoteTool } = await vite.ssrLoadModule("/services/tools/updateNoteTool.ts");
  const { executeTool } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const fresh = () => {
    const note = database.saveNote("Workshop", "Private notes", "meeting").note;
    database.updateNote(note.id, {
      enhanced_content: "## Decisions\nKeep it\n\n## Next\nDo it",
      transcript: "Source",
      enhancement_prompt: "Prompt",
      enhanced_at_content_hash: "hash",
    });
    return database.getNote(note.id);
  };
  const tokenFor = (id) => database.getNoteUndos().find((edit) => edit.noteId === id)?.token;
  const edit = (note, updates, turn) =>
    updateNoteTool.execute(
      { id: note.id, ...updates },
      turn && { messageId: turn, signal: new AbortController().signal }
    );

  for (const operation of ["rename", "move"])
    await t.test(
      `${operation} with extraneous blanks preserves documents and metadata`,
      async () => {
        const note = fresh();
        const folder = database.createFolder(`Folder ${note.id}`, note.space_id).folder;
        const result = await edit(note, {
          ...(operation === "rename" ? { title: "Renamed" } : { folder: folder.name }),
          content: "",
          summary: " \n ",
        });
        assert.equal(result.success, true);
        assert.deepEqual(result.data.ignoredFields, ["content", "summary"]);
        // The model is told the blanks cleared nothing; the user sees only the edit.
        assert.match(result.data.guidance, /nothing was cleared.*clear_fields/);
        assert.doesNotMatch(result.displayText, /blank|clear_fields/i);
        const saved = database.getNote(note.id);
        for (const key of [
          "content",
          "enhanced_content",
          "transcript",
          "enhancement_prompt",
          "enhanced_at_content_hash",
        ])
          assert.equal(saved[key], note[key]);
        assert.equal(
          saved[operation === "rename" ? "title" : "folder_id"],
          operation === "rename" ? "Renamed" : folder.id
        );
        assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
        assert.equal(database.getNote(note.id).folder_id, note.folder_id);
        assert.equal(database.getNote(note.id).title, note.title);
      }
    );

  await t.test(
    "omitted/null fields are absent, wrong types fail, unmarked blanks never clear",
    async () => {
      const note = fresh();
      assert.equal(
        (await edit(note, { title: "Renamed", content: null, summary: null })).success,
        true
      );
      assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
      const token = tokenFor(note.id);
      for (const fields of [
        { content: 3 },
        { summary: false },
        { title: {} },
        { folder: [] },
        { clear_fields: "summary" },
        { clear_fields: ["transcript"] },
        { summary: "replacement", clear_fields: ["summary"] },
        { summary: "" },
        {},
      ]) {
        assert.equal((await edit(note, fields)).success, false, JSON.stringify(fields));
        assert.equal(tokenFor(note.id), token);
        assert.equal(database.getNote(note.id).content, note.content);
        assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
      }
    }
  );

  await t.test(
    "a numeric string ID edits the note; a malformed one names the argument",
    async () => {
      const note = fresh();
      assert.equal((await edit(note, { id: String(note.id), title: "By string" })).success, true);
      assert.equal(database.getNote(note.id).title, "By string");
      const result = await edit(note, { id: `${note.id}x`, title: "Rejected" });
      assert.equal(result.success, false);
      assert.equal(result.displayText, "Invalid note update argument: id");
      assert.equal(database.getNote(note.id).title, "By string");
    }
  );

  await t.test(
    "an expired recovery is neither offered nor restorable, and launch prunes it",
    async () => {
      const note = fresh();
      await edit(note, { title: "Old edit" });
      const token = tokenFor(note.id);
      database.db
        .prepare("UPDATE assistant_note_undo SET created_at = ? WHERE token = ?")
        .run(Date.now() - UNDO_TTL_MS - 1, token);
      assert.equal(tokenFor(note.id), undefined);
      assert.equal(database.undoNoteUpdate(token).success, false);
      assert.equal(database.getNote(note.id).title, "Old edit");
      initializeNoteUndo(database.db);
      const remaining = database.db
        .prepare("SELECT COUNT(*) AS count FROM assistant_note_undo WHERE token = ?")
        .get(token);
      assert.equal(remaining.count, 0);
    }
  );

  for (const field of ["content", "summary"])
    await t.test(`explicit ${field} clearing and reopen/Undo`, async () => {
      const note = fresh();
      const result = await edit(note, { clear_fields: [field] });
      assert.equal(result.success, true);
      assert.deepEqual(result.data.updatedFields, [field]);
      const key = field === "summary" ? "enhanced_content" : field;
      assert.equal(database.getNote(note.id)[key] ?? "", "");
      database.db.close();
      database.db = new (require("better-sqlite3"))(path.join(directory, "transcriptions.db"));
      assert.equal(database.getNote(note.id)[key] ?? "", "");
      assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
      const restored = database.getNote(note.id);
      for (const key of [
        "title",
        "content",
        "enhanced_content",
        "transcript",
        "enhancement_prompt",
        "enhanced_at_content_hash",
      ])
        assert.equal(restored[key], note[key]);
      assert.equal(tokenFor(note.id), undefined);
    });

  await t.test("Undo of a first summary clears it", async () => {
    const note = database.saveNote("Untouched", "Private notes", "meeting").note;
    await edit(database.getNote(note.id), { summary: "Written by the assistant" });
    assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
    const restored = database.getNote(note.id);
    assert.equal(restored.enhanced_content ?? "", "");
  });

  await t.test(
    "partial section removal; edits in one turn share an Undo, a later turn's stands alone",
    async () => {
      const note = fresh();
      await edit(note, { summary: "## Next\nDo it" }, "turn-1");
      const first = tokenFor(note.id);
      await edit(note, { title: "Renamed" }, "turn-1");
      const second = tokenFor(note.id);
      assert.notEqual(second, first);
      assert.equal(database.undoNoteUpdate(first).success, false);
      await edit(note, { content: "Later turn" }, "turn-2");
      assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
      assert.equal(database.getNote(note.id).content, note.content);
      assert.equal(database.getNote(note.id).title, "Renamed", "an earlier turn stays applied");
      assert.equal(tokenFor(note.id), undefined);

      const other = fresh();
      await edit(other, { summary: "## Next\nDo it" }, "turn-3");
      await edit(other, { title: "Renamed" }, "turn-3");
      assert.equal(database.undoNoteUpdate(tokenFor(other.id)).success, true);
      assert.equal(database.getNote(other.id).title, other.title);
      assert.equal(database.getNote(other.id).enhanced_content, other.enhanced_content);
    }
  );

  await t.test("edits of one note in the same model step both apply", async () => {
    const note = fresh();
    const results = await Promise.all([
      edit(note, { summary: "## Next\nDo it" }, "step"),
      edit(note, { content: "Added reminder" }, "step"),
    ]);
    assert.deepEqual(
      results.map((result) => result.success),
      [true, true]
    );
    assert.equal(database.getNote(note.id).enhanced_content, "## Next\nDo it");
    assert.equal(database.getNote(note.id).content, "Added reminder");
    assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
    assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
    assert.equal(database.getNote(note.id).content, note.content);
  });

  await t.test("each recovery is offered once", async () => {
    const note = fresh();
    await edit(note, { title: "Offered" });
    const token = tokenFor(note.id);
    assert.equal(database.claimNoteUndo(token), true);
    assert.equal(database.claimNoteUndo(token), false);
    assert.equal(database.claimNoteUndo("missing"), false);
    assert.equal(database.undoNoteUpdate(token).success, true, "claiming keeps it restorable");
  });

  await t.test("launch replaces an older Undo trigger", async () => {
    database.db.exec(`
      DROP TRIGGER assistant_note_undo_update;
      CREATE TRIGGER assistant_note_undo_update AFTER UPDATE ON notes BEGIN SELECT 1; END;
    `);
    initializeNoteUndo(database.db);
    const note = fresh();
    await edit(note, { title: "Renamed" });
    database.updateNote(note.id, { content: "Manual edit" });
    assert.equal(tokenFor(note.id), undefined);
  });

  await t.test("failed save rolls back and cannot create recovery", async () => {
    const note = fresh();
    const stub = t.mock.method(database, "updateNote", () => ({ success: false }));
    const result = await edit(note, { title: "Failed" });
    stub.mock.restore();
    assert.equal(result.success, false);
    assert.equal(tokenFor(note.id), undefined);
    assert.equal(database.getNote(note.id).title, note.title);
  });

  await t.test(
    "late committed save remains undoable after registry cancellation and note switch",
    async () => {
      const note = fresh();
      const other = fresh();
      const controller = new AbortController();
      let release, started;
      const saving = new Promise((resolve) => {
        started = resolve;
      });
      const stub = t.mock.method(globalThis.window.electronAPI, "updateNote", async (...args) => {
        const result = database.updateNote(...args);
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
        return result;
      });
      // A failed assertion must not leave the stalled stub in place: every
      // later edit would wait on it forever.
      try {
        const pending = executeTool(
          updateNoteTool,
          { id: note.id, content: "Assistant replacement" },
          { signal: controller.signal }
        );
        await saving;
        controller.abort();
        assert.equal((await pending).success, false);
        assert.equal(database.getNote(other.id).content, other.content);
        assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
      } finally {
        release?.();
        await new Promise((resolve) => setImmediate(resolve));
        stub.mock.restore();
      }
      assert.equal(database.getNote(note.id).content, note.content);
    }
  );

  for (const change of ["manual", "edit and revert", "hard deleted", "identity", "dirty draft"])
    await t.test(`${change} prevents a stale Undo`, async () => {
      const note = fresh();
      await edit(note, { content: "Assistant replacement" });
      const token = tokenFor(note.id);
      if (change === "manual") database.updateNote(note.id, { title: "Manual title" });
      if (change === "edit and revert") {
        database.updateNote(note.id, { content: "Manual edit" });
        database.updateNote(note.id, { content: "Assistant replacement" });
      }
      if (change === "hard deleted")
        database.db.prepare("DELETE FROM notes WHERE id = ?").run(note.id);
      if (change === "identity")
        database.updateNote(note.id, { client_note_id: "replacement-identity" });
      if (change === "dirty draft") database.discardNoteUndo(note.id);
      const before = database.getNote(note.id);
      assert.equal(database.undoNoteUpdate(token).success, false);
      assert.deepEqual(database.getNote(note.id), before);
    });

  await t.test("journal failure rolls back the edit; failed Undo retains recovery", async () => {
    const note = fresh();
    database.db.exec(
      "CREATE TEMP TRIGGER fail_undo_journal BEFORE INSERT ON assistant_note_undo BEGIN SELECT RAISE(ABORT, 'disk full'); END"
    );
    assert.equal((await edit(note, { title: "Must roll back" })).success, false);
    database.db.exec("DROP TRIGGER fail_undo_journal");
    assert.equal(database.getNote(note.id).title, note.title);
    assert.equal(tokenFor(note.id), undefined);
    await edit(note, { title: "Recoverable" });
    const token = tokenFor(note.id);
    const failure = t.mock.method(database, "updateNote", () => ({
      success: false,
      error: "disk full",
    }));
    assert.equal(database.undoNoteUpdate(token).success, false);
    failure.mock.restore();
    assert.equal(tokenFor(note.id), token);
    assert.equal(database.getNote(note.id).title, "Recoverable");
  });

  await t.test("a removal that would leave a field empty is pointed to clear_fields", async () => {
    const note = fresh();
    const result = await edit(note, { summary: " " });
    assert.equal(result.success, false);
    assert.match(result.displayText, /removal that leaves nothing\), use clear_fields/);
    const renamed = await edit(note, { title: "", folder: " ", content: "Kept" });
    assert.equal(renamed.success, true);
    assert.deepEqual(renamed.data.ignoredFields, ["title", "folder"]);
    assert.doesNotMatch(renamed.data.guidance, /clear_fields/);
    assert.equal(database.getNote(note.id).title, note.title);
  });

  // Every note write stamps updated_at, so an old stamp that survives proves nothing was written.
  const UNWRITTEN = "2000-01-01 00:00:00";
  const markUnwritten = (id) =>
    database.db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(UNWRITTEN, id);

  await t.test("an unchanged or unsupported edit writes nothing", async () => {
    const note = fresh();
    markUnwritten(note.id);
    assert.equal((await edit(note, { title: note.title })).success, true);
    database.updateNote(note.id, { content: "" });
    markUnwritten(note.id);
    assert.equal((await edit(note, { clear_fields: ["content"] })).success, true);
    assert.equal(database.getNote(note.id).updated_at, UNWRITTEN);
    assert.equal(tokenFor(note.id), undefined);
    const direct = database.updateNote(
      note.id,
      { transcript: "Rewritten" },
      { undoable: true, expected: database.getNote(note.id) }
    );
    assert.equal(direct.success, false);
    assert.equal(database.getNote(note.id).transcript, note.transcript);
  });

  await t.test(
    "clearing a never-written summary writes nothing and keeps the last Undo",
    async () => {
      const note = fresh();
      database.updateNote(note.id, { enhanced_content: null });
      await edit(note, { title: "Renamed first" }, "turn-1");
      const token = tokenFor(note.id);
      markUnwritten(note.id);
      assert.equal((await edit(note, { clear_fields: ["summary"] }, "turn-2")).success, true);
      assert.equal(database.getNote(note.id).enhanced_content, null);
      assert.equal(database.getNote(note.id).updated_at, UNWRITTEN);
      assert.equal(tokenFor(note.id), token);
    }
  );

  await t.test("a toast's discard retires only its own recovery", async () => {
    const note = fresh();
    await edit(note, { title: "First" });
    const first = tokenFor(note.id);
    await edit(note, { title: "Second" });
    const second = tokenFor(note.id);
    database.discardNoteUndo(note.id, first);
    assert.equal(tokenFor(note.id), second);
    database.discardNoteUndo(note.id, second);
    assert.equal(tokenFor(note.id), undefined);
  });

  await t.test("a journal of an earlier shape is replaced at launch", async () => {
    database.db.exec(`
      DROP TABLE assistant_note_undo;
      CREATE TABLE assistant_note_undo (note_id INTEGER PRIMARY KEY, token TEXT, previous TEXT);
    `);
    initializeNoteUndo(database.db);
    const note = fresh();
    await edit(note, { title: "After repair" });
    assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
  });

  await t.test("a setup that fails after dropping the journal leaves note writes working", (t) => {
    database.db.exec(`
      DROP TABLE assistant_note_undo;
      CREATE TABLE assistant_note_undo (note_id INTEGER PRIMARY KEY, token TEXT, previous TEXT);
    `);
    const exec = database.db.exec.bind(database.db);
    const failure = t.mock.method(database.db, "exec", (sql) => {
      if (sql.includes("CREATE TABLE")) throw new Error("SQLITE_FULL: database or disk is full");
      return exec(sql);
    });
    assert.throws(() => initializeNoteUndo(database.db), /SQLITE_FULL/);
    failure.mock.restore();
    const note = fresh();
    assert.equal(database.updateNote(note.id, { title: "Plain edit" }).success, true);
    initializeNoteUndo(database.db);
  });

  await t.test("without the journal, assistant edits still save", async () => {
    database.noteUndoReady = false;
    try {
      const note = fresh();
      assert.equal((await edit(note, { title: "No journal" })).success, true);
      assert.equal(database.getNote(note.id).title, "No journal");
      assert.deepEqual(database.getNoteUndos(), []);
      assert.equal(database.claimNoteUndo("any"), false);
      database.discardNoteUndo(note.id);
    } finally {
      database.noteUndoReady = true;
    }
  });

  await t.test("concurrent changes before commit fail truthfully", async () => {
    const note = fresh();
    const stub = t.mock.method(
      globalThis.window.electronAPI,
      "updateNote",
      async (id, updates, options) => {
        database.updateNote(id, { content: "Concurrent edit" });
        return database.updateNote(id, updates, options);
      }
    );
    const result = await edit(note, { summary: "New summary" });
    stub.mock.restore();
    assert.equal(result.success, false);
    assert.match(result.displayText, /Note changed/);
    assert.equal(database.getNote(note.id).content, "Concurrent edit");
    assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
    assert.equal(tokenFor(note.id), undefined);
  });

  await t.test("a deleted previous folder or a note that is gone cannot restore", async () => {
    const note = fresh();
    const folder = database.createFolder(`Original ${note.id}`, note.space_id).folder;
    database.updateNote(note.id, { folder_id: folder.id });
    await edit(note, { folder: `New ${note.id}` });
    const token = tokenFor(note.id);
    database.db.prepare("UPDATE folders SET deleted_at = '2026-10-09' WHERE id = ?").run(folder.id);
    assert.equal(database.undoNoteUpdate(token).success, false);
    const goneNote = fresh();
    await edit(goneNote, { title: "Changed" });
    const goneToken = tokenFor(goneNote.id);
    const missing = t.mock.method(database, "getNote", () => null);
    assert.equal(database.undoNoteUpdate(goneToken).success, false);
    missing.mock.restore();
    assert.equal(database.getNote(goneNote.id).title, "Changed");
  });
});
