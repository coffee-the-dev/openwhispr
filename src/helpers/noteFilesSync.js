const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const defaultMirror = require("./markdownMirror");

// Bump when the exported file layout changes: the first launch on a new
// version rebuilds the mirror, which renames files the previous layout wrote.
const FORMAT_VERSION = 2;
const DEFAULT_DEBOUNCE_MS = 400;

// Drives the one-way note-files mirror from database change events: queues
// the notes a write touched, coalesces bursts (live meeting transcripts update
// every few seconds), and renders each note with its folder, speaker names and
// linked calendar event.
class NoteFilesSync {
  constructor({
    databaseManager,
    mirror = defaultMirror,
    stateFilePath = null,
    translate = null,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  }) {
    this.databaseManager = databaseManager;
    this.mirror = mirror;
    this.stateFilePath = stateFilePath;
    this.translate = translate;
    this.debounceMs = debounceMs;
    this.enabled = false;
    this.exportDictations = false;
    this._pendingUpserts = new Set();
    this._pendingDeletes = new Map();
    this._pendingVacatedFolders = new Set();
    this._timer = null;
    databaseManager?.addNoteChangeListener?.((change) => this.handleChange(change));
  }

  handleChange(change) {
    if (!this.enabled || !change) return;
    if (change.type === "upsert") {
      this._pendingUpserts.add(change.noteId);
    } else if (change.type === "delete") {
      this._pendingUpserts.delete(change.noteId);
      this._pendingDeletes.set(change.noteId, change.clientNoteId ?? null);
    } else if (change.type === "folder-vacated") {
      this._pendingVacatedFolders.add(change.name);
    } else {
      return;
    }
    this._schedule();
  }

  _schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.debounceMs);
    this._timer.unref?.();
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const upserts = [...this._pendingUpserts];
    const deletes = [...this._pendingDeletes];
    const vacated = [...this._pendingVacatedFolders];
    this._pendingUpserts.clear();
    this._pendingDeletes.clear();
    this._pendingVacatedFolders.clear();
    if (!this.enabled) return;

    for (const [noteId, clientNoteId] of deletes) this.mirror.deleteNote(noteId, clientNoteId);
    for (const noteId of upserts) {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (note) this.mirror.writeNote(note, this.buildContext(note));
      } catch (error) {
        debugLogger.error("Failed to mirror note", { noteId, error: error.message }, "note-files");
      }
    }
    for (const name of vacated) this.mirror.removeFolderIfEmpty(name);
  }

  _folderName(folderId) {
    if (!folderId) return "Personal";
    const folder = this.databaseManager.db
      ?.prepare("SELECT name FROM folders WHERE id = ?")
      .get(folderId);
    return folder?.name || "Personal";
  }

  _speakerMappings(noteId) {
    const map = {};
    for (const m of this.databaseManager.getSpeakerMappings?.(noteId) || []) {
      map[m.speaker_id] = m.display_name;
    }
    return map;
  }

  buildContext(note) {
    const t = this.translate;
    return {
      folderName: this._folderName(note.folder_id),
      speakerMappings: note.transcript ? this._speakerMappings(note.id) : {},
      calendarEvent: note.calendar_event_id
        ? this.databaseManager.getCalendarEventById?.(note.calendar_event_id) || null
        : null,
      transcriptLabel: t ? t("settings.noteFiles.export.transcriptLink") : undefined,
      notesHeading: t ? t("settings.noteFiles.export.notesHeading") : undefined,
    };
  }

  _statePath() {
    return typeof this.stateFilePath === "function" ? this.stateFilePath() : this.stateFilePath;
  }

  _readState() {
    const statePath = this._statePath();
    if (!statePath) return null;
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      return null;
    }
  }

  _writeState(basePath) {
    const statePath = this._statePath();
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ formatVersion: FORMAT_VERSION, basePath }),
        "utf8"
      );
    } catch (error) {
      debugLogger.warn("Failed to record note-files state", { error: error.message }, "note-files");
    }
  }

  enable(basePath, { skipRebuild = false, baseTag, exportDictations } = {}) {
    this.enabled = true;
    if (exportDictations !== undefined) this.exportDictations = !!exportDictations;
    this.mirror.init(basePath, { baseTag });
    const state = this._readState();
    const upToDate = state?.formatVersion === FORMAT_VERSION && state?.basePath === basePath;
    if (!skipRebuild || !upToDate) this.rebuild();
  }

  disable() {
    this.enabled = false;
    this._pendingUpserts.clear();
    this._pendingDeletes.clear();
    this._pendingVacatedFolders.clear();
  }

  setOptions({ baseTag, exportDictations } = {}) {
    if (exportDictations !== undefined) this.exportDictations = !!exportDictations;
    if (baseTag !== undefined) {
      const before = this.mirror.getBaseTag();
      this.mirror.setOptions({ baseTag });
      if (this.enabled && this.mirror.getBaseTag() !== before) this.rebuild();
    }
  }

  rebuild(basePath) {
    if (basePath) this.mirror.init(basePath);
    this.flush();
    const notes = this.databaseManager.getNotes(null, 99999);
    this.mirror.rebuildAll(notes.map((note) => ({ note, ctx: this.buildContext(note) })));
    this._writeState(this.mirror.getBasePath());
  }

  appendDictation(text, when) {
    if (!this.enabled || !this.exportDictations) return;
    this.mirror.appendDictation(text, when);
  }

  ensureFolder(name) {
    if (this.enabled) this.mirror.ensureFolder(name);
  }

  getNotePath(noteId) {
    if (!this.enabled) return null;
    const note = this.databaseManager.getNote(noteId);
    if (!note) return null;
    this.flush();
    const filePath = this.mirror.getNotePath(note.id, note.client_note_id || null);
    return filePath && fs.existsSync(filePath) ? filePath : null;
  }
}

module.exports = { NoteFilesSync, FORMAT_VERSION };
