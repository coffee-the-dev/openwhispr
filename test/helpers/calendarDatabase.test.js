const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
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

function appleEvent(id, overrides = {}) {
  return {
    id,
    calendar_id: "apple-calendar",
    provider: "apple",
    summary: id,
    start_time: "2026-07-20T10:00:00Z",
    end_time: "2026-07-20T11:00:00Z",
    is_all_day: false,
    status: "confirmed",
    ...overrides,
  };
}

test("Apple snapshots retain events referenced by meeting notes", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([appleEvent("linked-event"), appleEvent("unlinked-event")]);
  const note = db.saveNote("Linked meeting", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "linked-event" });

  db.replaceAppleCalendarEvents([]);

  assert.equal(db.getCalendarEventById("linked-event")?.summary, "linked-event");
  assert.equal(db.getCalendarEventById("unlinked-event"), null);
  db.db.close();
});

test("tentative Apple events remain visible in upcoming meetings", (t) => {
  const db = createDb(t);
  if (!db) return;

  const now = Date.now();
  db.upsertCalendarEvents([
    appleEvent("tentative-event", {
      start_time: new Date(now + 5 * 60_000).toISOString(),
      end_time: new Date(now + 35 * 60_000).toISOString(),
      status: "tentative",
    }),
  ]);

  const events = db.getUpcomingEvents(15);
  assert.equal(
    events.some((event) => event.id === "tentative-event"),
    true
  );
  db.db.close();
});

function insertAppleCalendar(db, id) {
  db.db.prepare("INSERT INTO apple_calendars (id, title) VALUES (?, ?)").run(id, id);
}

test("calendar availability fields are persisted with events", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([
    appleEvent("free-declined", {
      availability_status: "free",
      self_response_status: "declined",
    }),
  ]);

  const event = db.getCalendarEventById("free-declined");
  assert.equal(event.availability_status, "free");
  assert.equal(event.self_response_status, "declined");
  db.db.close();
});

test("availability range query uses overlap boundaries and known calendars", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertAppleCalendar(db, "apple-calendar");

  db.upsertCalendarEvents([
    appleEvent("ends-at-start", {
      start_time: "2026-07-22T09:00:00Z",
      end_time: "2026-07-22T10:00:00Z",
    }),
    appleEvent("overlaps", {
      start_time: "2026-07-22T09:30:00Z",
      end_time: "2026-07-22T10:30:00Z",
    }),
    appleEvent("removed-calendar", {
      calendar_id: "gone-calendar",
      start_time: "2026-07-22T10:15:00Z",
      end_time: "2026-07-22T10:45:00Z",
    }),
  ]);

  const events = db.getCalendarEventsInRange("2026-07-22T10:00:00Z", "2026-07-22T11:00:00Z", [
    "apple",
  ]);
  assert.deepEqual(
    events.map((event) => event.id),
    ["overlaps"]
  );
  db.db.close();
});

test("availability range query treats date-only all-day events as local dates", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertAppleCalendar(db, "apple-calendar");
  db.upsertCalendarEvents([
    appleEvent("all-day", {
      start_time: "2026-07-22",
      end_time: "2026-07-23",
      is_all_day: true,
    }),
  ]);

  const events = db.getCalendarEventsInRange(
    new Date(2026, 6, 22, 9).toISOString(),
    new Date(2026, 6, 22, 18).toISOString(),
    ["apple"]
  );
  assert.deepEqual(
    events.map((event) => event.id),
    ["all-day"]
  );
  db.db.close();
});

test("reopening drops Google and Microsoft calendar data", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db.exec(`
    CREATE TABLE google_calendar_tokens (id INTEGER PRIMARY KEY, refresh_token TEXT);
    CREATE TABLE microsoft_calendars (id TEXT PRIMARY KEY);
  `);
  db.upsertCalendarEvents([
    appleEvent("apple-event"),
    appleEvent("google-event", { provider: "google", calendar_id: "google-calendar" }),
    appleEvent("microsoft-event", { provider: "microsoft", calendar_id: "ms-calendar" }),
  ]);
  db.db.close();

  const reopened = new DatabaseManager();
  const tables = reopened.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?")
    .all("%_calendar%")
    .map((row) => row.name);
  assert.equal(tables.includes("google_calendar_tokens"), false);
  assert.equal(tables.includes("microsoft_calendars"), false);
  assert.equal(reopened.getCalendarEventById("apple-event")?.summary, "apple-event");
  assert.equal(reopened.getCalendarEventById("google-event"), null);
  assert.equal(reopened.getCalendarEventById("microsoft-event"), null);
  reopened.db.close();
});

test("only self-declined schedule rows are hidden, and reacceptance restores them", (t) => {
  const db = createDb(t);
  if (!db) return;
  t.after(() => db.db.close());
  const now = Date.now();
  const make = (id, response) =>
    appleEvent(id, {
      start_time: new Date(now - 5 * 60_000).toISOString(),
      end_time: new Date(now + 30 * 60_000).toISOString(),
      self_response_status: response,
    });
  const declined = make("declined", "declined");
  db.upsertCalendarEvents([
    declined,
    ...["accepted", "tentative", "needsAction", "unknown"].map((response) =>
      make(response, response)
    ),
  ]);
  const note = db.saveNote("Declined meeting notes", "Keep", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "declined" });
  const expected = ["accepted", "needsAction", "tentative", "unknown"];
  for (const events of [db.getUpcomingEvents(60), db.getActiveEvents()]) {
    assert.deepEqual(events.map((e) => e.id).sort(), expected);
  }
  assert.equal(
    db.db.prepare("SELECT calendar_event_id FROM notes WHERE id=?").get(note.id).calendar_event_id,
    "declined"
  );
  db.upsertCalendarEvents([{ ...declined, self_response_status: "accepted" }]);
  assert.ok(db.getUpcomingEvents(60).some((e) => e.id === "declined"));
  assert.ok(db.getActiveEvents().some((e) => e.id === "declined"));
});
