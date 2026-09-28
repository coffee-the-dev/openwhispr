process.env.TZ = "UTC";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return { app: { isReady: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let markdownMirror;
let parseFrontmatter;
try {
  markdownMirror = require("../../src/helpers/markdownMirror");
  ({ parseFrontmatter } = require("../../src/helpers/noteExportFormat"));
} finally {
  Module._load = originalLoad;
}

function tempBase(t) {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-mirror-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  markdownMirror.init(basePath, { baseTag: "openwhispr" });
  return basePath;
}

const transcript = (text = "Hello from the meeting.") =>
  JSON.stringify([{ speaker: "speaker_0", timestamp: 0, text }]);

function meeting(overrides = {}) {
  return {
    id: 42,
    client_note_id: "uid-42",
    title: "Weekly sync",
    content: "Initial notes",
    note_type: "meeting",
    created_at: "2026-07-21 12:00:00",
    updated_at: "2026-07-21 13:00:00",
    transcript: transcript(),
    ...overrides,
  };
}

const ls = (dir) => fs.readdirSync(dir).sort();

test("notes and transcripts get dated, human-readable file names in their folder", (t) => {
  const basePath = tempBase(t);
  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });

  const dir = path.join(basePath, "Meetings");
  assert.deepEqual(ls(dir), [
    "2026-07-21 Weekly sync (transcript).md",
    "2026-07-21 Weekly sync.md",
  ]);
  assert.equal(
    markdownMirror.getNotePath(42, "uid-42"),
    path.join(dir, "2026-07-21 Weekly sync.md")
  );
});

test("a retitled note is renamed in place, never duplicated", (t) => {
  const basePath = tempBase(t);
  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });
  markdownMirror.writeNote(meeting({ title: "Renamed sync", content: "Updated" }), {
    folderName: "Meetings",
  });

  const dir = path.join(basePath, "Meetings");
  assert.deepEqual(ls(dir), [
    "2026-07-21 Renamed sync (transcript).md",
    "2026-07-21 Renamed sync.md",
  ]);
  assert.match(fs.readFileSync(path.join(dir, "2026-07-21 Renamed sync.md"), "utf8"), /Updated/);
});

test("a name taken by a file the mirror does not own is disambiguated, not overwritten", (t) => {
  const basePath = tempBase(t);
  const dir = path.join(basePath, "Meetings");
  fs.mkdirSync(dir, { recursive: true });
  const userFile = path.join(dir, "2026-07-21 Weekly sync.md");
  fs.writeFileSync(userFile, "my own note", "utf8");

  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });

  assert.equal(fs.readFileSync(userFile, "utf8"), "my own note");
  assert.ok(fs.existsSync(path.join(dir, "2026-07-21 Weekly sync (ow42).md")));
  assert.ok(fs.existsSync(path.join(dir, "2026-07-21 Weekly sync (ow42) (transcript).md")));
});

test("a file with another database's openwhispr_uid is not claimed", (t) => {
  const basePath = tempBase(t);
  const dir = path.join(basePath, "Meetings");
  fs.mkdirSync(dir, { recursive: true });
  const foreign = path.join(dir, "2026-07-01 Old.md");
  const foreignBody = "---\nopenwhispr_id: 42\nopenwhispr_uid: other\n---\n\nold export\n";
  fs.writeFileSync(foreign, foreignBody, "utf8");

  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });
  markdownMirror.deleteNote(42, "uid-42");

  assert.equal(fs.readFileSync(foreign, "utf8"), foreignBody);
  assert.deepEqual(ls(dir), ["2026-07-01 Old.md"]);
});

test("legacy <id>-<slug> files are renamed to the new scheme and gain frontmatter", (t) => {
  const basePath = tempBase(t);
  const dir = path.join(basePath, "Meetings");
  fs.mkdirSync(dir, { recursive: true });
  const note = meeting({ id: 11, client_note_id: "uid-11", title: "Steve / Pragya" });
  fs.writeFileSync(
    path.join(dir, "11-steve---pragya.md"),
    "---\nid: 11\ntitle: Steve / Pragya\ntype: meeting\nfolder: Meetings\ncreated: 2026-07-21 12:00:00\nupdated: 2026-07-21 13:00:00\n---\n\nold body",
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "11-steve---pragya-transcript.md"),
    "# Steve / Pragya\n\n**Date:** July 21\n",
    "utf8"
  );
  const unrelated = path.join(dir, "12-something-else.md");
  fs.writeFileSync(unrelated, "---\nid: 12\ncreated: x\n---\n", "utf8");

  markdownMirror.init(basePath);
  markdownMirror.writeNote(note, { folderName: "Meetings" });

  assert.deepEqual(ls(dir), [
    "12-something-else.md",
    "2026-07-21 Steve Pragya (transcript).md",
    "2026-07-21 Steve Pragya.md",
  ]);
  const fields = parseFrontmatter(
    fs.readFileSync(path.join(dir, "2026-07-21 Steve Pragya.md"), "utf8")
  );
  assert.equal(fields.openwhispr_id, "11");
  assert.equal(fields.title, "Steve / Pragya");
});

test("legacy files from a different note with the same id are left alone", (t) => {
  const basePath = tempBase(t);
  const dir = path.join(basePath, "Meetings");
  fs.mkdirSync(dir, { recursive: true });
  const legacy = path.join(dir, "42-weekly-sync.md");
  fs.writeFileSync(legacy, "---\nid: 42\ncreated: 2025-01-01 00:00:00\n---\n\nold", "utf8");
  const legacyTranscript = path.join(dir, "42-weekly-sync-transcript.md");
  fs.writeFileSync(legacyTranscript, "# Weekly sync\n", "utf8");

  markdownMirror.init(basePath);
  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });

  assert.ok(fs.existsSync(legacy));
  assert.ok(fs.existsSync(legacyTranscript));
});

test("moving a note between folders moves its files and an emptied folder is removed", (t) => {
  const basePath = tempBase(t);
  markdownMirror.writeNote(meeting(), { folderName: "Research" });
  markdownMirror.writeNote(meeting(), { folderName: "Archive" });
  markdownMirror.removeFolderIfEmpty("Research");

  assert.equal(markdownMirror.getFolderPath("Research"), null);
  assert.equal(ls(path.join(basePath, "Archive")).length, 2);
});

test("removing a folder keeps it while it holds files the mirror does not own", (t) => {
  const basePath = tempBase(t);
  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });
  const userFile = path.join(basePath, "Meetings", "Mine.md");
  fs.writeFileSync(userFile, "keep me", "utf8");

  markdownMirror.deleteNote(42, "uid-42");
  markdownMirror.removeFolderIfEmpty("Meetings");

  assert.deepEqual(ls(path.join(basePath, "Meetings")), ["Mine.md"]);
});

test("clearing a transcript removes only the owned transcript file", (t) => {
  const basePath = tempBase(t);
  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });
  markdownMirror.writeNote(meeting({ transcript: null }), { folderName: "Meetings" });

  assert.deepEqual(ls(path.join(basePath, "Meetings")), ["2026-07-21 Weekly sync.md"]);
});

test("a file renamed in the vault is still found by its openwhispr_id", (t) => {
  const basePath = tempBase(t);
  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });
  const dir = path.join(basePath, "Meetings");
  fs.renameSync(path.join(dir, "2026-07-21 Weekly sync.md"), path.join(dir, "moved.md"));

  markdownMirror.init(basePath);
  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });

  assert.deepEqual(ls(dir), [
    "2026-07-21 Weekly sync (transcript).md",
    "2026-07-21 Weekly sync.md",
  ]);
});

test("folder names cannot escape the configured mirror directory", (t) => {
  const basePath = tempBase(t);
  markdownMirror.writeNote(
    { id: 13, title: "Safe note", content: "Body" },
    {
      folderName: "../outside",
    }
  );

  const notePath = markdownMirror.getNotePath(13);
  assert.ok(notePath);
  assert.equal(path.relative(basePath, notePath).startsWith(".."), false);
  assert.equal(parseFrontmatter(fs.readFileSync(notePath, "utf8")).folder, "../outside");
});

test("unsafe and Windows-reserved folder names use distinct portable keys", (t) => {
  tempBase(t);
  const folderNames = ["team/docs", "team-docs", "CON", "NUL.txt", "folder.", "folder "];
  folderNames.forEach((folderName, index) => {
    markdownMirror.writeNote({ id: 20 + index, title: `Note ${index}` }, { folderName });
  });

  const diskNames = folderNames.map((folderName) =>
    path.basename(markdownMirror.getFolderPath(folderName))
  );
  assert.equal(new Set(diskNames).size, folderNames.length);
  for (const diskName of diskNames) {
    assert.doesNotMatch(diskName, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i);
    assert.doesNotMatch(diskName, /[ .]$/);
  }
});

test("writes reject a symlinked folder that resolves outside the mirror", (t) => {
  const basePath = tempBase(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  fs.symlinkSync(outsidePath, path.join(basePath, "linked"), "dir");

  markdownMirror.writeNote({ id: 16, title: "Escaped", content: "Body" }, { folderName: "linked" });

  assert.deepEqual(fs.readdirSync(outsidePath), []);
  assert.equal(markdownMirror.getFolderPath("linked"), null);
});

test("a symlink at the target name is never written through", (t) => {
  const basePath = tempBase(t);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-markdown-outside-"));
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  const outsideFile = path.join(outsidePath, "outside.md");
  fs.writeFileSync(outsideFile, "unchanged", "utf8");
  markdownMirror.ensureFolder("Personal");
  fs.symlinkSync(outsideFile, path.join(basePath, "Personal", "2026-07-21 Linked.md"), "file");

  markdownMirror.writeNote(
    { id: 17, title: "Linked", content: "Replacement", created_at: "2026-07-21 12:00:00" },
    { folderName: "Personal" }
  );

  assert.equal(fs.readFileSync(outsideFile, "utf8"), "unchanged");
  assert.equal(path.basename(markdownMirror.getNotePath(17)), "2026-07-21 Linked (ow17).md");
});

test("deleteNote removes the note's other file even when one unlink fails", (t) => {
  const basePath = tempBase(t);
  markdownMirror.writeNote(meeting(), { folderName: "Meetings" });
  const dir = path.join(basePath, "Meetings");

  const realUnlink = fs.unlinkSync;
  let failedPath = null;
  fs.unlinkSync = (target) => {
    if (failedPath === null) {
      failedPath = target;
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    }
    return realUnlink(target);
  };
  t.after(() => {
    fs.unlinkSync = realUnlink;
  });

  markdownMirror.deleteNote(42, "uid-42");
  fs.unlinkSync = realUnlink;

  assert.deepEqual(fs.readdirSync(dir), [path.basename(failedPath)]);
});

test("a file re-saved with a BOM or CRLF is still recognised as the note's", (t) => {
  const basePath = tempBase(t);
  markdownMirror.writeNote(meeting({ transcript: null }), { folderName: "Meetings" });
  const notePath = path.join(basePath, "Meetings", "2026-07-21 Weekly sync.md");
  const original = fs.readFileSync(notePath, "utf8");

  for (const rewritten of [original.replace(/\n/g, "\r\n"), `\uFEFF${original}`]) {
    fs.writeFileSync(notePath, rewritten, "utf8");
    markdownMirror.init(basePath);
    assert.equal(markdownMirror.getNotePath(42, "uid-42"), notePath);
  }
});

test("dictations append to an owned daily file and never to a user's file", (t) => {
  const basePath = tempBase(t);
  const dir = path.join(basePath, "Dictations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-07-21.md"), "user daily note", "utf8");

  markdownMirror.appendDictation("First thought", new Date("2026-07-21T09:05:00Z"));
  markdownMirror.appendDictation("Second\nline", new Date("2026-07-21T10:30:00Z"));

  assert.equal(fs.readFileSync(path.join(dir, "2026-07-21.md"), "utf8"), "user daily note");
  const owned = fs.readFileSync(path.join(dir, "2026-07-21 (openwhispr).md"), "utf8");
  assert.equal(parseFrontmatter(owned).openwhispr_dictations, "2026-07-21");
  assert.match(owned, /- \*\*09:05\*\* First thought\n- \*\*10:30\*\* Second\n {2}line\n$/);
});
