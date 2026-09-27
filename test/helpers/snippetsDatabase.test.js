const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-snippets-db-"));
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
const { skipOrFail } = require("./harness/db.js");

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-snippets-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    skipOrFail(t, error);
    return null;
  }

  try {
    return new DatabaseManager();
  } catch (error) {
    skipOrFail(t, error);
    return null;
  }
}

test("snippets diff trims, dedupes, and updates in place", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setSnippets([
    { trigger: "  signoff  ", replacement: "  Regards  " },
    { trigger: "SIGNOFF", replacement: "Ignored duplicate" },
  ]);

  assert.deepEqual(db.getSnippets(), [{ trigger: "signoff", replacement: "Regards" }]);
  const { id } = db.db.prepare("SELECT id FROM snippets").get();

  db.setSnippets([{ trigger: "Signoff", replacement: "Cheers" }]);
  assert.deepEqual(db.getSnippets(), [{ trigger: "Signoff", replacement: "Cheers" }]);
  assert.equal(db.db.prepare("SELECT id FROM snippets").get().id, id);
});

test("snippet removals delete the rows", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setSnippets([
    { trigger: "keep", replacement: "Kept" },
    { trigger: "drop", replacement: "Dropped" },
  ]);

  db.setSnippets([{ trigger: "keep", replacement: "Kept" }]);

  assert.deepEqual(db.getSnippets(), [{ trigger: "keep", replacement: "Kept" }]);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM snippets").get().n, 1);
});

test("setSnippets drops triggers longer than the limit", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setSnippets([
    { trigger: "x".repeat(101), replacement: "too long" },
    { trigger: "ok", replacement: "fine" },
  ]);

  assert.deepEqual(db.getSnippets(), [{ trigger: "ok", replacement: "fine" }]);
});
