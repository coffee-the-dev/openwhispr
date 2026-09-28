const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const format = require("./noteExportFormat");

const ENCODED_FOLDER_PREFIX = "__ow-";
const WINDOWS_RESERVED_FOLDER = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const DICTATIONS_FOLDER = "Dictations";
const HEADER_BYTES = 4096;
const LEGACY_NOTE_FILE = /^(\d+)-.+\.md$/;
const IGNORABLE_DIR_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

// One-way export of notes into a directory — typically an Obsidian vault
// folder the user also writes to. The mirror only ever renames, overwrites or
// deletes files it provably owns: a frontmatter `openwhispr_id` (plus
// `openwhispr_uid` when the note has one) naming the note, or — for the
// one-time rename of pre-Obsidian exports — the exact legacy file shape for a
// note that still exists. Anything else in the directory is never touched.
class MarkdownMirror {
  constructor() {
    this._basePath = null;
    this._baseRealPath = null;
    this._index = null;
    this._options = { baseTag: format.DEFAULT_BASE_TAG };
  }

  init(basePath, options) {
    this._basePath = basePath;
    this._baseRealPath = null;
    this._index = null;
    if (options) this.setOptions(options);
    try {
      fs.mkdirSync(basePath, { recursive: true });
      this._baseRealPath = fs.realpathSync(basePath);
      debugLogger.debug("Markdown mirror initialized", { basePath }, "note-files");
    } catch (err) {
      debugLogger.error("Failed to init markdown mirror", { error: err.message }, "note-files");
    }
  }

  setOptions(options = {}) {
    if (options.baseTag !== undefined) {
      this._options.baseTag = format.sanitizeTag(options.baseTag) || format.DEFAULT_BASE_TAG;
    }
  }

  getBaseTag() {
    return this._options.baseTag;
  }

  getBasePath() {
    return this._basePath;
  }

  _safeFolderName(folderName) {
    const raw = String(folderName || "Personal");
    const requiresEncoding =
      raw === "." ||
      raw === ".." ||
      raw.startsWith(" ") ||
      /[ .]$/.test(raw) ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(raw) ||
      WINDOWS_RESERVED_FOLDER.test(raw) ||
      raw.toLowerCase().startsWith(ENCODED_FOLDER_PREFIX);
    if (!requiresEncoding) return raw;

    const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
    return `${ENCODED_FOLDER_PREFIX}${digest}`;
  }

  _isInsideBase(candidatePath) {
    if (!this._baseRealPath) return false;
    const relative = path.relative(this._baseRealPath, candidatePath);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  _folderCandidatePath(folderName) {
    if (!this._baseRealPath) return null;
    return path.join(this._baseRealPath, this._safeFolderName(folderName));
  }

  _displayPath(canonicalPath) {
    const relative = path.relative(this._baseRealPath, canonicalPath);
    return path.join(this._basePath, relative);
  }

  _resolveExistingFolderPath(candidatePath) {
    const stats = fs.lstatSync(candidatePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Markdown mirror folder is not a regular directory");
    }

    const realPath = fs.realpathSync(candidatePath);
    if (!this._isInsideBase(realPath)) {
      throw new Error("Markdown mirror folder resolves outside the configured directory");
    }
    return realPath;
  }

  _resolveFolderPath(folderName, { create = false } = {}) {
    const candidatePath = this._folderCandidatePath(folderName);
    if (!candidatePath) return null;

    if (!fs.existsSync(candidatePath)) {
      if (!create) return null;
      fs.mkdirSync(candidatePath, { recursive: true });
    }
    return this._resolveExistingFolderPath(candidatePath);
  }

  _isRegularFile(filePath) {
    try {
      const stats = fs.lstatSync(filePath);
      return stats.isFile() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  _assertWritableFilePath(filePath) {
    let stats;
    try {
      stats = fs.lstatSync(filePath);
    } catch {
      return;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Markdown mirror file is not a regular file");
    }
  }

  _readHead(filePath) {
    let fd;
    try {
      if (!this._isRegularFile(filePath)) return null;
      fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(HEADER_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // Two paths name the same file — true for a case-only rename on a
  // case-insensitive volume, where the strings differ.
  _sameFile(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try {
      const sa = fs.statSync(a);
      const sb = fs.statSync(b);
      return sa.ino === sb.ino && sa.dev === sb.dev;
    } catch {
      return false;
    }
  }

  _mirrorDirectories() {
    if (!this._baseRealPath) return [];
    const dirs = [];
    try {
      for (const entry of fs.readdirSync(this._baseRealPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          dirs.push(this._resolveExistingFolderPath(path.join(this._baseRealPath, entry.name)));
        } catch {}
      }
    } catch {}
    return dirs;
  }

  // Scans <base>/<folder>/*.md once; writes keep it current afterwards.
  _buildIndex() {
    const owned = new Map();
    const legacyNotes = new Map();
    for (const dirPath of this._mirrorDirectories()) {
      let files;
      try {
        files = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(dirPath, file);
        const head = this._readHead(filePath);
        if (head == null) continue;
        const fields = format.parseFrontmatter(head);
        if (fields?.openwhispr_id && /^\d+$/.test(fields.openwhispr_id)) {
          const id = Number(fields.openwhispr_id);
          const kind = fields.summary !== undefined ? "transcript" : "note";
          if (!owned.has(id)) owned.set(id, []);
          owned.get(id).push({ path: filePath, kind, uid: fields.openwhispr_uid || null });
          continue;
        }
        const legacy = LEGACY_NOTE_FILE.exec(file);
        if (legacy && fields?.id === legacy[1] && fields.openwhispr_id === undefined) {
          const id = Number(legacy[1]);
          if (!legacyNotes.has(id)) legacyNotes.set(id, []);
          legacyNotes.get(id).push({ path: filePath, created: fields.created ?? null });
        }
      }
    }
    return { owned, legacyNotes };
  }

  _getIndex() {
    if (!this._index) this._index = this._buildIndex();
    return this._index;
  }

  _ownsEntry(entry, noteUid) {
    return (entry.uid || null) === (noteUid || null);
  }

  _ownedFiles(noteId, noteUid) {
    const entries = (this._getIndex().owned.get(noteId) || []).filter(
      (entry) => this._ownsEntry(entry, noteUid) && this._isRegularFile(entry.path)
    );
    const pick = (kind) => entries.find((entry) => entry.kind === kind)?.path || null;
    return { note: pick("note"), transcript: pick("transcript") };
  }

  _recordOwned(noteId, noteUid, kind, filePath) {
    const index = this._getIndex();
    const entries = (index.owned.get(noteId) || []).filter(
      (entry) => !(entry.kind === kind && this._ownsEntry(entry, noteUid))
    );
    if (filePath) entries.push({ path: filePath, kind, uid: noteUid || null });
    index.owned.set(noteId, entries);
  }

  // A legacy note file carries `id` and the raw `created_at` it was written
  // with; both must match, so a reset database's note 1 never adopts the old
  // export of a different note 1.
  _findLegacyNote(note) {
    const candidates = this._getIndex().legacyNotes.get(note.id) || [];
    const match = candidates.find(
      (candidate) =>
        candidate.created != null &&
        candidate.created === String(note.created_at ?? "") &&
        this._isRegularFile(candidate.path)
    );
    return match?.path || null;
  }

  // Legacy transcripts carried no frontmatter; they are recognised only by the
  // exact old file name next to the note's legacy file and a first line that
  // is the note's title as an H1.
  _findLegacyTranscript(note, legacyNotePath) {
    if (!legacyNotePath) return null;
    const candidate = path.join(
      path.dirname(legacyNotePath),
      format.legacyTranscriptFileName(note)
    );
    const head = this._readHead(candidate);
    if (head == null || format.parseFrontmatter(head)) return null;
    const firstLine = head.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
    return firstLine === `# ${note.title || "Untitled"}` ? candidate : null;
  }

  _pathAvailable(filePath, ownPaths) {
    if (!fs.existsSync(filePath)) return true;
    return ownPaths.some((own) => this._sameFile(filePath, own));
  }

  _chooseStem(dirPath, note, hasTranscript, ownNotePaths, ownTranscriptPaths) {
    const candidates = [format.buildFileStem(note), format.buildFileStem(note, `ow${note.id}`)];
    for (let n = 2; n <= 20; n++) candidates.push(format.buildFileStem(note, `ow${note.id}-${n}`));
    for (const stem of candidates) {
      const notePath = path.join(dirPath, format.noteFileName(stem));
      const transcriptPath = path.join(dirPath, format.transcriptFileName(stem));
      if (!this._pathAvailable(notePath, ownNotePaths)) continue;
      // Reserve the transcript name even for a note without one yet, so a
      // transcript arriving later never forces the note to be renamed.
      if (!this._pathAvailable(transcriptPath, ownTranscriptPaths)) continue;
      return stem;
    }
    throw new Error("No free file name for note");
  }

  _placeFile(sourcePath, targetPath, content) {
    this._assertWritableFilePath(targetPath);
    if (sourcePath && sourcePath !== targetPath) {
      this._assertWritableFilePath(sourcePath);
      fs.renameSync(sourcePath, targetPath);
    }
    fs.writeFileSync(targetPath, content, "utf-8");
  }

  // ctx: { folderName, speakerMappings, calendarEvent, transcriptLabel, notesHeading }
  writeNote(note, ctx = {}) {
    if (!this._baseRealPath || !note?.id) return;
    try {
      const folderName = ctx.folderName || "Personal";
      const dirPath = this._resolveFolderPath(folderName, { create: true });
      if (!dirPath) return;

      const uid = note.client_note_id || null;
      const current = this._ownedFiles(note.id, uid);
      const legacyNote = current.note ? null : this._findLegacyNote(note);
      const legacyTranscript =
        current.transcript || !legacyNote ? null : this._findLegacyTranscript(note, legacyNote);
      const sourceNote = current.note || legacyNote;
      const sourceTranscript = current.transcript || legacyTranscript;

      const hasTranscript = format.parseSegments(note).length > 0;
      const stem = this._chooseStem(
        dirPath,
        note,
        hasTranscript,
        [sourceNote].filter(Boolean),
        [sourceTranscript].filter(Boolean)
      );
      const renderCtx = { ...ctx, folderName, baseTag: this._options.baseTag };

      const notePath = path.join(dirPath, format.noteFileName(stem));
      this._placeFile(sourceNote, notePath, format.buildNoteMarkdown(note, renderCtx, stem));
      this._recordOwned(note.id, uid, "note", notePath);

      if (hasTranscript) {
        const transcriptPath = path.join(dirPath, format.transcriptFileName(stem));
        this._placeFile(
          sourceTranscript,
          transcriptPath,
          format.buildTranscriptMarkdown(note, renderCtx, stem)
        );
        this._recordOwned(note.id, uid, "transcript", transcriptPath);
      } else if (current.transcript) {
        fs.unlinkSync(current.transcript);
        this._recordOwned(note.id, uid, "transcript", null);
      }
    } catch (err) {
      debugLogger.error(
        "Failed to write note file",
        { noteId: note.id, error: err.message },
        "note-files"
      );
    }
  }

  deleteNote(noteId, noteUid = null) {
    if (!this._baseRealPath) return;
    const current = this._ownedFiles(noteId, noteUid);
    for (const [kind, filePath] of Object.entries(current)) {
      if (!filePath) continue;
      // Isolate each unlink: a file we can't remove (e.g. locked by an external
      // editor) must not orphan the note's other mirrored file.
      try {
        fs.unlinkSync(filePath);
        this._recordOwned(noteId, noteUid, kind, null);
      } catch (err) {
        debugLogger.error(
          "Failed to delete note file",
          { noteId, file: filePath, error: err.message },
          "note-files"
        );
      }
    }
  }

  ensureFolder(folderName) {
    if (!this._baseRealPath) return;
    try {
      this._resolveFolderPath(folderName, { create: true });
    } catch (err) {
      debugLogger.error(
        "Failed to ensure folder",
        { folderName, error: err.message },
        "note-files"
      );
    }
  }

  // A folder's notes move by being rewritten into their new folder; the old
  // directory goes only once nothing but OS metadata is left in it.
  removeFolderIfEmpty(folderName) {
    if (!this._baseRealPath) return;
    try {
      const dirPath = this._resolveFolderPath(folderName);
      if (!dirPath) return;
      const entries = fs.readdirSync(dirPath);
      if (entries.some((entry) => !IGNORABLE_DIR_ENTRIES.has(entry))) return;
      for (const entry of entries) fs.unlinkSync(path.join(dirPath, entry));
      fs.rmdirSync(dirPath);
    } catch (err) {
      debugLogger.error(
        "Failed to remove empty folder",
        { folderName, error: err.message },
        "note-files"
      );
    }
  }

  // entries: [{ note, ctx }]
  rebuildAll(entries) {
    if (!this._baseRealPath) return;
    try {
      this._index = null;
      for (const { note, ctx } of entries) this.writeNote(note, ctx);
      debugLogger.info("Markdown mirror rebuild complete", { count: entries.length }, "note-files");
    } catch (err) {
      debugLogger.error("Failed to rebuild all note files", { error: err.message }, "note-files");
    }
  }

  getNotePath(noteId, noteUid = null) {
    if (!this._baseRealPath) return null;
    const filePath = this._ownedFiles(noteId, noteUid).note;
    return filePath ? this._displayPath(filePath) : null;
  }

  get DICTATIONS_FOLDER() {
    return DICTATIONS_FOLDER;
  }

  // Where a folder's files go, whether or not the directory exists yet.
  getFolderDisplayPath(folderName) {
    if (!this._basePath) return null;
    return path.join(this._basePath, this._safeFolderName(folderName));
  }

  getFolderPath(folderName) {
    if (!this._baseRealPath) return null;
    try {
      const canonicalPath = this._resolveFolderPath(folderName);
      return canonicalPath ? this._displayPath(canonicalPath) : null;
    } catch {
      return null;
    }
  }

  _dictationFilePath(dirPath, date) {
    const day = format.dictationFileStem(date);
    for (const name of [`${day}.md`, `${day} (openwhispr).md`]) {
      const filePath = path.join(dirPath, name);
      if (!fs.existsSync(filePath)) return { filePath, isNew: true };
      const fields = format.parseFrontmatter(this._readHead(filePath) || "");
      if (this._isRegularFile(filePath) && fields?.openwhispr_dictations === day) {
        return { filePath, isNew: false };
      }
    }
    return null;
  }

  appendDictation(text, when = new Date()) {
    if (!this._baseRealPath || !String(text || "").trim()) return;
    try {
      const date = when instanceof Date ? when : new Date(when);
      const dirPath = this._resolveFolderPath(DICTATIONS_FOLDER, { create: true });
      if (!dirPath) return;
      const target = this._dictationFilePath(dirPath, date);
      if (!target) return;
      const entry = format.buildDictationEntry(date, text);
      if (target.isNew) {
        fs.writeFileSync(
          target.filePath,
          format.buildDictationHeader(date, this._options.baseTag) + entry,
          { encoding: "utf-8", flag: "wx" }
        );
      } else {
        const { size } = fs.statSync(target.filePath);
        let separator = "";
        if (size > 0) {
          const fd = fs.openSync(target.filePath, "r");
          try {
            const last = Buffer.alloc(1);
            fs.readSync(fd, last, 0, 1, size - 1);
            if (last[0] !== 0x0a) separator = "\n";
          } finally {
            fs.closeSync(fd);
          }
        }
        fs.appendFileSync(target.filePath, separator + entry, "utf-8");
      }
    } catch (err) {
      debugLogger.error("Failed to append dictation", { error: err.message }, "note-files");
    }
  }
}

module.exports = new MarkdownMirror();
module.exports.MarkdownMirror = MarkdownMirror;
