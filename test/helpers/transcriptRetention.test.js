const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-retention-db-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-retention-db-"));
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

function insert(db, text, ageDays) {
  const { lastInsertRowid } = db.db
    .prepare("INSERT INTO transcriptions (text, created_at) VALUES (?, datetime('now', ?))")
    .run(text, `-${ageDays} days`);
  return lastInsertRowid;
}

test("purges local transcriptions past the retention window and keeps the rest", (t) => {
  const db = createDb(t);
  if (!db) return;

  const stale = insert(db, "two days old", 2);
  const fresh = insert(db, "a few hours old", 0);

  const { ids } = db.deleteTranscriptionsExpiredBefore(1);

  assert.deepEqual(ids, [stale]);
  const remaining = db.db
    .prepare("SELECT id FROM transcriptions")
    .all()
    .map((r) => r.id);
  assert.deepEqual(remaining, [fresh]);
});

test("a second purge finds nothing left to remove", (t) => {
  const db = createDb(t);
  if (!db) return;

  insert(db, "stale", 10);
  db.deleteTranscriptionsExpiredBefore(7);

  assert.deepEqual(db.deleteTranscriptionsExpiredBefore(7).ids, []);
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM transcriptions").get().c, 0);
});

function insertAnalytics(db, eventId, ageDays) {
  db.recordAnalyticsEvent({
    eventId,
    wordCount: 4,
    occurredAt: "2026-08-30T10:00:00.000Z",
    localDate: "2026-08-30",
    spokenDurationMs: 2_000,
    mode: "local",
    provider: "local-whisper",
    model: "small",
  });
  // Backdated explicitly on created_at: that is the column the purge compares,
  // and it is the only one whose format matches the cutoff (see the purge).
  db.db
    .prepare("UPDATE analytics_events SET created_at = datetime('now', ?) WHERE event_id = ?")
    .run(`-${ageDays} days`, eventId);
}

test("retention purges analytics counters on the same schedule as transcripts", (t) => {
  const db = createDb(t);
  if (!db) return;

  insertAnalytics(db, "stale-a", 10);
  insertAnalytics(db, "stale-b", 10);
  insertAnalytics(db, "fresh", 0);

  const { analyticsPurged } = db.deleteTranscriptionsExpiredBefore(7);

  assert.equal(analyticsPurged, 2);
  assert.deepEqual(
    db.db
      .prepare("SELECT event_id FROM analytics_events")
      .all()
      .map((row) => row.event_id),
    ["fresh"]
  );
  assert.equal(db.getAnalyticsSummary().totalDictations, 1);
});
