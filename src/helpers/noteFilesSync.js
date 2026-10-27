const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const defaultMirror = require("./markdownMirror");
const format = require("./noteExportFormat");
const importFormat = require("./noteImportFormat");
const { parseNoteDate } = require("./transcriptFormatter");

// Bump when the exported file layout changes: the first launch on a new
// version rebuilds the mirror, which renames files the previous layout wrote.
const FORMAT_VERSION = 3;
const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_IMPORT_DEBOUNCE_MS = 1500;
// Only when the folder can't be watched (fs.watch failed).
const IMPORT_POLL_MS = 60_000;

// Keeps the note-files folder and the database in step. Database change
// events are queued, coalesced (live meeting transcripts update every few
// seconds) and written out with each note's folder, speaker names and linked
// calendar event. In the other direction, notes exported by another computer
// sharing the folder (a synced vault) are imported: new uids become notes,
// and a file whose `openwhispr_updated` is newer than the note replaces what
// changed. Edits made by hand in the vault don't move that time, so they are
// still overwritten. A note deleted here leaves a tombstone, so its copy in
// the folder is not imported again unless it changed after the delete.
class NoteFilesSync {
  constructor({
    databaseManager,
    mirror = defaultMirror,
    stateFilePath = null,
    translate = null,
    onImport = null,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    importDebounceMs = DEFAULT_IMPORT_DEBOUNCE_MS,
    watch = true,
  }) {
    this.databaseManager = databaseManager;
    this.mirror = mirror;
    this.stateFilePath = stateFilePath;
    this.translate = translate;
    this.onImport = onImport;
    this.debounceMs = debounceMs;
    this.importDebounceMs = importDebounceMs;
    this.watch = watch;
    this.enabled = false;
    this.exportDictations = false;
    this._pendingUpserts = new Set();
    this._pendingDeletes = new Map();
    this._pendingVacatedFolders = new Set();
    this._timer = null;
    this._importTimer = null;
    this._watcher = null;
    this._pollTimer = null;
    this._importing = false;
    databaseManager?.addNoteChangeListener?.((change) => this.handleChange(change));
  }

  handleChange(change) {
    if (!change) return;
    if (change.type === "delete" && change.clientNoteId) this._recordTombstone(change.clientNoteId);
    if (!this.enabled) return;
    if (change.type === "upsert") {
      // An imported note's file is the one it came from; rewriting it would
      // only churn the vault.
      if (this._importing) return;
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

  _updateState(patch) {
    const statePath = this._statePath();
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ ...this._readState(), ...patch }), "utf8");
    } catch (error) {
      debugLogger.warn("Failed to record note-files state", { error: error.message }, "note-files");
    }
  }

  _recordTombstone(clientNoteId) {
    const deleted = { ...this._readState()?.deleted, [clientNoteId]: new Date().toISOString() };
    this._updateState({ deleted });
  }

  enable(basePath, { skipRebuild = false, baseTag, exportDictations } = {}) {
    this.enabled = true;
    if (exportDictations !== undefined) this.exportDictations = !!exportDictations;
    this.mirror.init(basePath, { baseTag });
    const state = this._readState();
    const upToDate = state?.formatVersion === FORMAT_VERSION && state?.basePath === basePath;
    // Import first: a rewrite would otherwise replace a newer file from
    // another computer with this database's older copy.
    this.importFromFiles();
    if (!skipRebuild || !upToDate) this._writeAll();
    this._startWatching();
  }

  disable() {
    this.enabled = false;
    this._stopWatching();
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
    this.importFromFiles();
    this._writeAll();
    if (basePath) this._startWatching();
  }

  _writeAll() {
    this.flush();
    const notes = this.databaseManager.getNotes(null, 99999);
    this.mirror.rebuildAll(notes.map((note) => ({ note, ctx: this.buildContext(note) })));
    this._updateState({ formatVersion: FORMAT_VERSION, basePath: this.mirror.getBasePath() });
  }

  _labels() {
    const t = this.translate;
    return importFormat.buildLabels(t ? (key, options) => t(key, options) : null);
  }

  // The current note parsed back from its own export, so it compares with a
  // file field by field in the same form.
  _parsedLocal(note, labels) {
    const ctx = this.buildContext(note);
    const stem = format.buildFileStem(note);
    const hasTranscript = format.parseSegments(note).length > 0;
    return importFormat.parseExportedNote(
      format.buildNoteMarkdown(note, ctx, stem),
      hasTranscript ? format.buildTranscriptMarkdown(note, ctx, stem) : null,
      labels
    );
  }

  /**
   * Imports notes exported into the folder that this database doesn't have,
   * and newer versions of ones it does. Returns the notes it created and
   * changed (also passed to `onImport`).
   */
  importFromFiles() {
    const result = { created: [], updated: [] };
    if (!this.enabled) return result;
    let entries;
    try {
      entries = this.mirror.scanExportedNotes();
    } catch (error) {
      debugLogger.error("Failed to scan note files", { error: error.message }, "note-files");
      return result;
    }
    const tombstones = this._readState()?.deleted || {};
    const revived = [];
    const labels = this._labels();
    for (const entry of entries) {
      try {
        const fileUpdated = importFormat.fileUpdatedAt(entry.fields)?.getTime();
        if (!fileUpdated) continue;
        const local = this.databaseManager.getNoteByClientNoteId(entry.uid);
        if (local) {
          if (fileUpdated <= parseNoteDate(local.updated_at).getTime()) continue;
        } else if (tombstones[entry.uid] && fileUpdated <= Date.parse(tombstones[entry.uid])) {
          continue;
        }
        const incoming = importFormat.parseExportedNote(
          fs.readFileSync(entry.notePath, "utf8"),
          entry.transcriptPath ? fs.readFileSync(entry.transcriptPath, "utf8") : null,
          labels
        );
        if (!incoming) continue;
        const columns = local
          ? importFormat.changedColumns(this._parsedLocal(local, labels) || {}, incoming)
          : importFormat.noteColumns(incoming);
        // Even with nothing to change, the note takes the file's time so the
        // next scan skips it.
        this._importing = true;
        let applied;
        try {
          applied = this.databaseManager.applyImportedNote(incoming.clientNoteId, columns, {
            createdAt: incoming.createdAt,
            updatedAt: incoming.updatedAt,
          });
        } finally {
          this._importing = false;
        }
        if (applied.created) {
          result.created.push(applied.note);
          if (tombstones[entry.uid]) revived.push(entry.uid);
        } else if (Object.keys(columns).length > 0) {
          result.updated.push(applied.note);
        }
      } catch (error) {
        debugLogger.error(
          "Failed to import note file",
          { file: path.basename(entry.notePath), error: error.message },
          "note-files"
        );
      }
    }
    if (revived.length > 0) {
      const deleted = { ...this._readState()?.deleted };
      for (const uid of revived) delete deleted[uid];
      this._updateState({ deleted });
    }
    if (result.created.length > 0 || result.updated.length > 0) {
      debugLogger.info(
        "Imported notes from note files",
        { created: result.created.length, updated: result.updated.length },
        "note-files"
      );
      try {
        this.onImport?.(result);
      } catch (error) {
        debugLogger.error(
          "Note-files import listener failed",
          { error: error.message },
          "note-files"
        );
      }
    }
    return result;
  }

  _scheduleImport() {
    if (this._importTimer || !this.enabled) return;
    this._importTimer = setTimeout(() => {
      this._importTimer = null;
      this.importFromFiles();
    }, this.importDebounceMs);
    this._importTimer.unref?.();
  }

  // Our own writes wake the watcher too; those scans find nothing newer.
  _startWatching() {
    this._stopWatching();
    const basePath = this.mirror.getBasePath();
    if (!this.watch || !basePath) return;
    const fallBackToPolling = (error) => {
      debugLogger.warn(
        "Cannot watch note files; checking every minute",
        { error: error.message },
        "note-files"
      );
      this._stopWatching();
      this._pollTimer = setInterval(() => this.importFromFiles(), IMPORT_POLL_MS);
      this._pollTimer.unref?.();
    };
    try {
      this._watcher = fs.watch(basePath, { recursive: true }, (_event, filename) => {
        if (!filename || String(filename).endsWith(".md")) this._scheduleImport();
      });
      this._watcher.on("error", fallBackToPolling);
      this._watcher.unref?.();
    } catch (error) {
      fallBackToPolling(error);
    }
  }

  _stopWatching() {
    this._watcher?.close();
    this._watcher = null;
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    clearTimeout(this._importTimer);
    this._importTimer = null;
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
