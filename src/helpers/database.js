const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const debugLogger = require("./debugLogger");
const { buildNoteSearchQuery } = require("./noteSearch");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const { parseEventTime } = require("./calendarAvailability");
// An explicit zone marks an instant this app captured at dictation time. A
// naive timestamp may predate that and must never outrank created_at when
// dating a historical row.
const { hasExplicitTimeZone, parseDbTimestamp, toDbTimestamp } = require("./dbTimestamp");
const { BUILTIN_ACTIONS, GENERATE_NOTES_KEY } = require("./builtinActions");
const {
  ANALYTICS_COUNTER_VERSION,
  ANALYTICS_HISTORY_BACKFILL_VERSION,
  ANALYTICS_HISTORICAL_COUNTER_VERSION,
  countSpokenWords,
  inferHistoricalAnalyticsMode,
  localDateKey,
  summarizeAnalyticsDays,
} = require("./analytics");
const { app } = require("electron");

// Keeps one oversized trigger from bloating the snippet list and prompt.
const MAX_SNIPPET_TRIGGER_LENGTH = 100;

function calendarEventsQuery(where) {
  return `SELECT * FROM calendar_events WHERE ${where} ORDER BY datetime(start_time) ASC`;
}

const AVAILABILITY_PROVIDERS = new Set(["apple"]);
const SELECTED_CALENDAR_EVENT_FILTER = `(
  provider = 'apple' AND EXISTS (
    SELECT 1 FROM apple_calendars WHERE apple_calendars.id = calendar_events.calendar_id
  )
)`;

class DatabaseManager {
  constructor() {
    this.db = null;
    this._noteChangeListener = null;
    this.initDatabase();
  }

  // One observer (the note-files mirror) hears every write that changes what a
  // note exports as: { type: "upsert", noteId } | { type: "delete", noteId,
  // clientNoteId } | { type: "folder-vacated", name }.
  setNoteChangeListener(listener) {
    this._noteChangeListener = listener;
  }

  _emitNoteChange(change) {
    if (!this._noteChangeListener) return;
    try {
      this._noteChangeListener(change);
    } catch (error) {
      debugLogger.error("Note change listener failed", { error: error.message }, "notes");
    }
  }

  _purgeSyncTombstones() {
    const deletedNotes = "SELECT id FROM notes WHERE deleted_at IS NOT NULL";
    const deletedFolders = "SELECT id FROM folders WHERE deleted_at IS NOT NULL";
    this.db.transaction(() => {
      this._deleteConversationsWhere(
        `deleted_at IS NOT NULL OR note_id IN (${deletedNotes}) OR folder_id IN (${deletedFolders})`,
        []
      );
      this._deleteSpeakerRowsForNotes(deletedNotes);
      this.db.exec(`
        DELETE FROM notes WHERE deleted_at IS NOT NULL;
        UPDATE notes SET folder_id = NULL WHERE folder_id IN (${deletedFolders});
        DELETE FROM folders WHERE deleted_at IS NOT NULL;
        DELETE FROM transcriptions WHERE deleted_at IS NOT NULL;
        DELETE FROM custom_dictionary WHERE deleted_at IS NOT NULL;
        DELETE FROM snippets WHERE deleted_at IS NOT NULL;
        DELETE FROM analytics_events WHERE deleted_at IS NOT NULL;
        DELETE FROM spaces WHERE deleted_at IS NOT NULL AND kind != 'private';
        DELETE FROM optimistic_folder_delete_rows;
        DELETE FROM space_accounts;
      `);
    })();
  }

  _getFolder(id) {
    return this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) || null;
  }

  // Moves every account-attributed or team-space folder, note, and chat into
  // the private space with no account, then drops the emptied team spaces. A
  // live folder whose name is already taken there merges into it when both are
  // defaults (each account seeded its own "Personal"); otherwise it is renamed
  // after its old space so no folder or note is lost.
  _rehomeAccountScopedRowsToLocal() {
    const privateSpace = this.db
      .prepare("SELECT id FROM spaces WHERE kind = 'private' ORDER BY id LIMIT 1")
      .get();
    if (!privateSpace) return;
    const privateId = privateSpace.id;

    this.db.transaction(() => {
      const folders = this.db
        .prepare(
          `SELECT folders.id, folders.name, folders.is_default, folders.deleted_at,
                  spaces.name AS space_name
           FROM folders LEFT JOIN spaces ON spaces.id = folders.space_id
           WHERE folders.account_id IS NOT NULL
              OR folders.space_id IS NULL OR folders.space_id != ?
           ORDER BY folders.deleted_at IS NOT NULL, folders.is_default DESC, folders.id`
        )
        .all(privateId);
      const findLocalFolder = this.db.prepare(
        `SELECT id, is_default FROM folders
         WHERE space_id = ? AND account_id IS NULL AND name = ? AND deleted_at IS NULL AND id != ?`
      );
      const rehomeFolder = this.db.prepare(
        "UPDATE folders SET space_id = ?, account_id = NULL, name = ? WHERE id = ?"
      );

      for (const folder of folders) {
        if (folder.deleted_at) {
          rehomeFolder.run(privateId, folder.name, folder.id);
          continue;
        }
        const existing = findLocalFolder.get(privateId, folder.name, folder.id);
        if (existing && existing.is_default && folder.is_default) {
          this.db
            .prepare("UPDATE notes SET folder_id = ?, space_id = ? WHERE folder_id = ?")
            .run(existing.id, privateId, folder.id);
          this.db
            .prepare(
              "UPDATE agent_conversations SET folder_id = ?, space_id = ? WHERE folder_id = ?"
            )
            .run(existing.id, privateId, folder.id);
          this.db
            .prepare("DELETE FROM optimistic_folder_delete_rows WHERE folder_id = ?")
            .run(folder.id);
          this.db.prepare("DELETE FROM folders WHERE id = ?").run(folder.id);
          continue;
        }
        let name = folder.name;
        if (existing) {
          const base = `${folder.name} (${folder.space_name || "Imported"})`;
          name = base;
          for (let n = 2; findLocalFolder.get(privateId, name, folder.id); n++) {
            name = `${base} ${n}`;
          }
        }
        rehomeFolder.run(privateId, name, folder.id);
      }

      this.db
        .prepare(
          `UPDATE notes SET space_id = ?, account_id = NULL
           WHERE account_id IS NOT NULL OR space_id IS NULL OR space_id != ?`
        )
        .run(privateId, privateId);
      this.db
        .prepare(
          "UPDATE agent_conversations SET space_id = ? WHERE space_id IS NOT NULL AND space_id != ?"
        )
        .run(privateId, privateId);
      this.db.exec("DELETE FROM space_accounts");
      this.db.prepare("DELETE FROM spaces WHERE kind = 'team'").run();
    })();
  }

  initDatabase() {
    try {
      const dbFileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

      const dbPath = path.join(app.getPath("userData"), dbFileName);

      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Audio retention columns
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN raw_text TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN has_audio INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN audio_duration_ms INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN provider TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN model TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE transcriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN error_message TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN error_code TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      // Records the dictation intent (e.g. "translation") so retry/recover re-runs the same route.
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN route_kind TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS snippets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trigger TEXT NOT NULL,
          replacement TEXT NOT NULL,
          client_snippet_id TEXT,
          cloud_id TEXT,
          sync_status TEXT DEFAULT 'pending',
          deleted_at TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled Note',
          content TEXT NOT NULL DEFAULT '',
          note_type TEXT NOT NULL DEFAULT 'personal',
          source_file TEXT,
          audio_duration_seconds REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_content TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhancement_prompt TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_at_content_hash TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          title,
          content,
          enhanced_content,
          content='notes',
          content_rowid='id'
        )
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
        END
      `);

      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO notes_fts(rowid, title, content, enhanced_content)
        SELECT id, COALESCE(title, ''), COALESCE(content, ''), COALESCE(enhanced_content, '')
        FROM notes
      `
        )
        .run();

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const folderCount = this.db.prepare("SELECT COUNT(*) as count FROM folders").get();
      if (folderCount.count === 0) {
        const seedFolder = this.db.prepare(
          "INSERT INTO folders (name, is_default, sort_order) VALUES (?, 1, ?)"
        );
        seedFolder.run("Personal", 0);
        seedFolder.run("Meetings", 1);
        seedFolder.run("Videos", 2);
      }

      // Backfill folder_id only when the column is first added: on later
      // launches a NULL folder_id is a legitimate space-root note, not a
      // pre-folders row.
      let folderColumnAdded = true;
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN folder_id INTEGER REFERENCES folders(id)");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
        folderColumnAdded = false;
      }

      if (folderColumnAdded) {
        const personalFolder = this.db
          .prepare("SELECT id FROM folders WHERE name = 'Personal' AND is_default = 1")
          .get();
        if (personalFolder) {
          this.db
            .prepare("UPDATE notes SET folder_id = ? WHERE folder_id IS NULL")
            .run(personalFolder.id);
        }
      }

      // One-time seed (user_version 1): a pre-existing user-created "Videos"
      // folder stays untouched (never promoted to default); URL downloads route
      // to it by name. Guarded so a later delete/rename doesn't resurrect it as
      // an undeletable default on the next launch.
      if (this.db.pragma("user_version", { simple: true }) < 1) {
        const videosFolder = this.db.prepare("SELECT id FROM folders WHERE name = 'Videos'").get();
        if (!videosFolder) {
          const maxOrder = this.db.prepare("SELECT MAX(sort_order) as m FROM folders").get();
          this.db
            .prepare(
              "INSERT OR IGNORE INTO folders (name, is_default, sort_order) VALUES ('Videos', 1, ?)"
            )
            .run((maxOrder?.m ?? 1) + 1);
        }
        this.db.pragma("user_version = 1");
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT 'sparkles',
          is_builtin INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE actions ADD COLUMN translation_key TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(conversation_id)"
      );

      try {
        this.db.exec("ALTER TABLE agent_messages ADD COLUMN metadata TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN archived_at DATETIME");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN note_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_conversations_note ON agent_conversations(note_id)"
      );
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN folder_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_conversations_container ON agent_conversations(space_id, folder_id)"
      );

      // Pre-2026 installs carry one built-in row under an older key: rename it to
      // Generate Notes so the loop below recognizes and upgrades it.
      const builtinKeys = BUILTIN_ACTIONS.map((action) => action.translationKey);
      this.db
        .prepare(
          `UPDATE actions SET translation_key = ? WHERE is_builtin = 1 AND (translation_key IS NULL OR translation_key NOT IN (${builtinKeys.map(() => "?").join(", ")}))`
        )
        .run(GENERATE_NOTES_KEY, ...builtinKeys);

      // Built-in actions: insert any that are missing, and roll a new default prompt
      // out to rows whose prompt is still a previous default (never a user edit).
      const selectBuiltin = this.db.prepare(
        "SELECT id, prompt FROM actions WHERE is_builtin = 1 AND translation_key = ?"
      );
      const insertBuiltin = this.db.prepare(
        "INSERT INTO actions (name, description, prompt, icon, is_builtin, sort_order, translation_key) VALUES (?, ?, ?, ?, 1, ?, ?)"
      );
      const upgradeBuiltin = this.db.prepare(
        "UPDATE actions SET name = ?, description = ?, prompt = ? WHERE id = ?"
      );
      for (const action of BUILTIN_ACTIONS) {
        const existing = selectBuiltin.get(action.translationKey);
        if (!existing) {
          insertBuiltin.run(
            action.name,
            action.description,
            action.prompt,
            action.icon,
            action.sortOrder,
            action.translationKey
          );
        } else if (action.previousPrompts.includes(existing.prompt)) {
          upgradeBuiltin.run(action.name, action.description, action.prompt, existing.id);
        }
      }

      // Google and Microsoft calendar sync kept OAuth tokens and calendar lists
      // in their own tables; nothing reads them in this build.
      this.db.exec(`
        DROP TABLE IF EXISTS google_calendar_tokens;
        DROP TABLE IF EXISTS google_calendars;
        DROP TABLE IF EXISTS microsoft_calendar_tokens;
        DROP TABLE IF EXISTS microsoft_calendars;
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id TEXT PRIMARY KEY,
          calendar_id TEXT NOT NULL,
          summary TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          is_all_day INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'confirmed',
          availability_status TEXT NOT NULL DEFAULT 'unknown',
          self_response_status TEXT NOT NULL DEFAULT 'unknown',
          hangout_link TEXT,
          conference_data TEXT,
          organizer_email TEXT,
          attendees_count INTEGER DEFAULT 0,
          synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec(
          "ALTER TABLE calendar_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      for (const column of ["availability_status", "self_response_status"]) {
        try {
          this.db.exec(
            `ALTER TABLE calendar_events ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'unknown'`
          );
        } catch (err) {
          if (!err.message.includes("duplicate column")) throw err;
        }
      }
      // Events synced from Google or Microsoft calendars; only Apple Calendar
      // fills this table now.
      this.db.exec("DELETE FROM calendar_events WHERE provider IN ('google', 'microsoft')");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS apple_calendars (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          color TEXT,
          source_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN transcript TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN calendar_event_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE calendar_events ADD COLUMN attendees TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN participants TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN diarization_enabled INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN expected_speaker_count INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          email TEXT PRIMARY KEY,
          display_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS speaker_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          display_name TEXT NOT NULL,
          email TEXT,
          embedding BLOB NOT NULL,
          sample_count INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS speaker_mappings (
          note_id INTEGER NOT NULL,
          speaker_id TEXT NOT NULL,
          profile_id INTEGER,
          display_name TEXT NOT NULL,
          PRIMARY KEY (note_id, speaker_id),
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
          FOREIGN KEY (profile_id) REFERENCES speaker_profiles(id) ON DELETE SET NULL
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS note_speaker_embeddings (
          note_id INTEGER NOT NULL,
          speaker_id TEXT NOT NULL,
          embedding BLOB NOT NULL,
          PRIMARY KEY (note_id, speaker_id),
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        )
      `);

      // Journal left by the removed cloud folder delete; the user_version 3
      // and 4 migrations clear it.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS optimistic_folder_delete_rows (
          folder_id INTEGER NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id INTEGER NOT NULL,
          original_sync_status TEXT,
          original_deleted_at TEXT,
          original_updated_at TEXT,
          PRIMARY KEY (folder_id, entity_type, entity_id)
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_optimistic_folder_delete_entity ON optimistic_folder_delete_rows(entity_type, entity_id)"
      );

      // Legacy sync columns. deleted_at feeds the user_version 4 tombstone cleanup.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN client_note_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN share_token TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN client_folder_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN updated_at DATETIME");
        this.db.exec("UPDATE folders SET updated_at = created_at WHERE updated_at IS NULL");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN client_conversation_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE agent_conversations ADD COLUMN sync_status TEXT DEFAULT 'pending'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE agent_conversations ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN client_transcription_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE transcriptions ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN client_dict_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN cloud_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec(
          "ALTER TABLE custom_dictionary ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN sync_status TEXT DEFAULT 'pending'");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE custom_dictionary ADD COLUMN updated_at DATETIME");
        this.db.exec(
          "UPDATE custom_dictionary SET updated_at = created_at WHERE updated_at IS NULL"
        );
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Backfill client IDs for existing rows: notes key imports and agent
      // tools on client_note_id, and Insights keys events on
      // client_transcription_id.
      const clientIdTables = [
        { table: "notes", col: "client_note_id" },
        { table: "transcriptions", col: "client_transcription_id" },
      ];
      for (const { table, col } of clientIdTables) {
        const rows = this.db.prepare(`SELECT id FROM ${table} WHERE ${col} IS NULL`).all();
        const stmt = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
        for (const row of rows) {
          stmt.run(randomUUID(), row.id);
        }
      }

      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_client_note_id ON notes(client_note_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_client_folder_id ON folders(client_folder_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_client_id ON agent_conversations(client_conversation_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_transcriptions_client_id ON transcriptions(client_transcription_id)"
      );

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS analytics_events (
          event_id TEXT PRIMARY KEY,
          account_id TEXT,
          occurred_at TEXT NOT NULL,
          local_date TEXT NOT NULL,
          word_count INTEGER NOT NULL CHECK (word_count > 0),
          spoken_duration_ms INTEGER,
          mode TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          counter_version INTEGER NOT NULL DEFAULT 1,
          sync_status TEXT NOT NULL DEFAULT 'pending',
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_analytics_events_account_date
          ON analytics_events(account_id, local_date);
        DROP TABLE IF EXISTS analytics_clear_requests;
        CREATE TABLE IF NOT EXISTS analytics_device_clear_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          cleared_through TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS analytics_history_backfill_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          scanned_through_transcription_id INTEGER NOT NULL DEFAULT 0
            CHECK (scanned_through_transcription_id >= 0)
        );
      `);
      // Databases from before analytics_events had deleted_at; the one-time
      // tombstone cleanup below reads it. SQLite has no ADD COLUMN IF NOT EXISTS.
      try {
        this.db.exec("ALTER TABLE analytics_events ADD COLUMN deleted_at TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_dictionary_client_id ON custom_dictionary(client_dict_id)"
      );
      this.db.exec("DROP TRIGGER IF EXISTS custom_dictionary_client_id_default");
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_client_id ON snippets(client_snippet_id) WHERE client_snippet_id IS NOT NULL"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_trigger_lower_active ON snippets(lower(trigger)) WHERE deleted_at IS NULL"
      );
      this.db.exec("DROP INDEX IF EXISTS idx_snippets_pending_sync");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS spaces (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          client_space_id TEXT,
          cloud_team_id   TEXT,
          workspace_id    TEXT,
          kind            TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('private','team')),
          name            TEXT NOT NULL,
          emoji           TEXT,
          sort_order      INTEGER NOT NULL DEFAULT 0,
          my_role         TEXT,
          member_count    INTEGER,
          sync_status     TEXT NOT NULL DEFAULT 'pending',
          deleted_at      TEXT,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_client_space_id ON spaces(client_space_id)"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_cloud_team_id ON spaces(cloud_team_id) WHERE cloud_team_id IS NOT NULL"
      );

      const privateSpaceCount = this.db
        .prepare("SELECT COUNT(*) as count FROM spaces WHERE kind = 'private'")
        .get();
      if (privateSpaceCount.count === 0) {
        this.db
          .prepare("INSERT INTO spaces (kind, name, sort_order) VALUES ('private', 'Personal', 0)")
          .run();
      }

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN space_id INTEGER");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      // Rebuild folders to drop the table-level UNIQUE(name); per-space name
      // uniqueness is enforced by idx_folders_space_name below.
      // better-sqlite3 enables foreign_keys by default, so DROP TABLE folders
      // would fail while notes.folder_id rows reference it; the pragma is a
      // no-op inside a transaction, so toggle it around the rebuild.
      const foldersTable = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
        .get();
      if (foldersTable?.sql.includes("UNIQUE")) {
        const foreignKeysWereOn = this.db.pragma("foreign_keys", { simple: true }) === 1;
        this.db.pragma("foreign_keys = OFF");
        try {
          this.db.transaction(() => {
            this.db.exec(`
            CREATE TABLE folders_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              is_default INTEGER NOT NULL DEFAULT 0,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              client_folder_id TEXT,
              cloud_id TEXT,
              sync_status TEXT DEFAULT 'pending',
              deleted_at TEXT,
              space_id INTEGER
            )
          `);
            this.db.exec(`
            INSERT INTO folders_new (id, name, is_default, sort_order, created_at, updated_at,
              client_folder_id, cloud_id, sync_status, deleted_at, space_id)
            SELECT id, name, is_default, sort_order, created_at, updated_at,
              client_folder_id, cloud_id, sync_status, deleted_at, space_id
            FROM folders
          `);
            this.db.exec("DROP TABLE folders");
            this.db.exec("ALTER TABLE folders_new RENAME TO folders");
            this.db.exec(
              "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_client_folder_id ON folders(client_folder_id)"
            );
          })();
        } finally {
          if (foreignKeysWereOn) this.db.pragma("foreign_keys = ON");
        }
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_space_name ON folders(space_id, name) WHERE deleted_at IS NULL"
      );

      const privateSpace = this.db.prepare("SELECT id FROM spaces WHERE kind = 'private'").get();
      this.db
        .prepare("UPDATE folders SET space_id = ? WHERE space_id IS NULL")
        .run(privateSpace.id);
      this.db.prepare("UPDATE notes SET space_id = ? WHERE space_id IS NULL").run(privateSpace.id);

      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes(folder_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at)");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_notes_space_updated ON notes(space_id, updated_at)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_folders_space_sort ON folders(space_id, sort_order)"
      );

      // Legacy account attribution; the user_version 3 re-home reads it.
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN account_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE folders ADD COLUMN account_id TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_account_id ON notes(account_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_folders_account_id ON folders(account_id)");
      this.db.exec("DROP INDEX IF EXISTS idx_folders_space_name");
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_space_legacy_name ON folders(space_id, name) WHERE deleted_at IS NULL AND account_id IS NULL"
      );
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_space_account_name ON folders(space_id, account_id, name) WHERE deleted_at IS NULL AND account_id IS NOT NULL"
      );

      // Legacy team-space membership; the user_version 3 and 4 migrations clear it.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS space_accounts (
          space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (space_id, account_id)
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_space_accounts_account_id ON space_accounts(account_id)"
      );

      // Space vector purges owed to Qdrant while the sidecar was down/booting;
      // drained on the next semantic search activation.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_vector_purges (
          space_id   INTEGER PRIMARY KEY,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this._initVectorChangeJournal();

      // One-time re-home (user_version 3): rows an account or a team space owned
      // under older builds move into the private space, the only one this build has.
      if (this.db.pragma("user_version", { simple: true }) < 3) {
        this._rehomeAccountScopedRowsToLocal();
        this.db.pragma("user_version = 3");
      }

      // One-time cleanup (user_version 4): cloud sync kept deleted rows as
      // tombstones until the server confirmed the delete. Nothing pushes them
      // any more, so they go for good.
      if (this.db.pragma("user_version", { simple: true }) < 4) {
        this._purgeSyncTombstones();
        this.db.pragma("user_version = 4");
      }

      return true;
    } catch (error) {
      debugLogger.error("Database initialization failed", { error: error.message }, "database");
      throw error;
    }
  }

  saveTranscription(
    text,
    rawText = null,
    {
      status = "completed",
      errorMessage = null,
      errorCode = null,
      routeKind = null,
      clientTranscriptionId = randomUUID(),
      analyticsOccurredAt = null,
    } = {}
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      // With an occurrence time this column carries when the dictation was
      // spoken rather than when the row was written -- earlier by the length
      // of the recording plus transcription. History reads it through
      // normalizeDbDate, which already branches on a trailing zone.
      // Keep the existing SQLite-friendly separator so mixed old/new rows
      // continue to sort chronologically, while the trailing Z marks this as
      // an exact client-captured instant for clear-state reconciliation.
      const occurredAt = toDbTimestamp(analyticsOccurredAt);
      const stmt = this.db.prepare(
        `INSERT INTO transcriptions (
           text, raw_text, status, error_message, error_code, route_kind,
           client_transcription_id, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
      );
      const result = stmt.run(
        text,
        rawText,
        status,
        errorMessage,
        errorCode,
        routeKind,
        clientTranscriptionId,
        occurredAt
      );

      const fetchStmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      const transcription = fetchStmt.get(result.lastInsertRowid);

      return { id: result.lastInsertRowid, success: true, transcription };
    } catch (error) {
      debugLogger.error("Error saving transcription", { error: error.message }, "database");
      throw error;
    }
  }

  _ensureAnalyticsHistoryBackfillState(version) {
    this.db
      .prepare(
        `INSERT INTO analytics_history_backfill_state (
           id, version, scanned_through_transcription_id
         ) VALUES (1, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           scanned_through_transcription_id = 0
         WHERE analytics_history_backfill_state.version <> excluded.version`
      )
      .run(version);
    return this.db
      .prepare(
        `SELECT version, scanned_through_transcription_id
         FROM analytics_history_backfill_state WHERE id = 1`
      )
      .get();
  }

  getAnalyticsHistoryBackfillState(version = ANALYTICS_HISTORY_BACKFILL_VERSION) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const safeVersion = Math.max(1, Math.trunc(Number(version)) || 1);
      return this.db.transaction(() => {
        const state = this._ensureAnalyticsHistoryBackfillState(safeVersion);
        const target = this.db
          .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM transcriptions")
          .get();
        return {
          version: safeVersion,
          scannedThroughId: Number(state.scanned_through_transcription_id),
          targetId: Number(target.id),
        };
      })();
    } catch (error) {
      debugLogger.error(
        "Error reading analytics history backfill state",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  _invalidateAnalyticsHistoryFromTranscription(id) {
    const resumeBeforeId = Math.max(0, Math.trunc(Number(id)) - 1);
    this.db
      .prepare(
        `INSERT INTO analytics_history_backfill_state (
           id, version, scanned_through_transcription_id
         ) VALUES (1, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           scanned_through_transcription_id = CASE
             WHEN analytics_history_backfill_state.version = excluded.version
             THEN MIN(
               analytics_history_backfill_state.scanned_through_transcription_id,
               ?
             )
             ELSE 0
           END`
      )
      .run(ANALYTICS_HISTORY_BACKFILL_VERSION, resumeBeforeId);
  }

  backfillAnalyticsHistoryBatch({
    afterId = 0,
    throughId = null,
    checkpointVersion = null,
    limit = 250,
  } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const safeLimit = Math.max(1, Math.min(Math.trunc(Number(limit)) || 250, 1_000));
      const safeAfterId = Math.max(0, Math.trunc(Number(afterId)) || 0);
      const safeThroughId =
        throughId === null || throughId === undefined
          ? null
          : Math.max(0, Math.trunc(Number(throughId)) || 0);
      const safeCheckpointVersion =
        checkpointVersion === null || checkpointVersion === undefined
          ? null
          : Math.max(1, Math.trunc(Number(checkpointVersion)) || 1);

      return this.db.transaction(() => {
        const checkpoint =
          safeCheckpointVersion === null
            ? null
            : this._ensureAnalyticsHistoryBackfillState(safeCheckpointVersion);
        const effectiveAfterId = checkpoint
          ? Number(checkpoint.scanned_through_transcription_id)
          : safeAfterId;
        if (safeThroughId !== null && effectiveAfterId >= safeThroughId) {
          return {
            complete: true,
            nextCursor: effectiveAfterId,
            scanned: 0,
            inserted: 0,
            skipped: 0,
          };
        }

        const clearState = this.db
          .prepare("SELECT cleared_through FROM analytics_device_clear_state WHERE id = 1")
          .get();
        // Legacy SQLite timestamps are completion times without an offset. Once
        // the user has cleared Insights, only a client-captured occurrence time
        // can prove that a historical row happened afterward, so an ambiguous
        // legacy row stays out rather than reviving a cleared counter. That is
        // the eligibility rule below; the boundary on the instant actually
        // written is enforced in the loop, where the chosen value is known.
        const rows = this.db
          .prepare(
            `SELECT transcription.id, transcription.client_transcription_id,
                    transcription.text, transcription.raw_text, transcription.timestamp,
                    transcription.created_at,
                    audio_duration_ms, provider, model
             FROM transcriptions transcription
             WHERE transcription.id > ?
               AND (? IS NULL OR transcription.id <= ?)
               AND transcription.status = 'completed'
               AND TRIM(COALESCE(NULLIF(TRIM(transcription.raw_text), ''), transcription.text, '')) != ''
               AND NOT EXISTS (
                 SELECT 1 FROM analytics_events event
                 WHERE event.event_id = TRIM(transcription.client_transcription_id)
               )
               AND (
                 ? IS NULL
                 OR (
                   (TRIM(transcription.timestamp) LIKE '%Z'
                    OR SUBSTR(TRIM(transcription.timestamp), -6, 1) IN ('+', '-'))
                   AND JULIANDAY(transcription.timestamp) > JULIANDAY(?)
                 )
               )
             ORDER BY transcription.id ASC
             LIMIT ?`
          )
          .all(
            effectiveAfterId,
            safeThroughId,
            safeThroughId,
            clearState?.cleared_through ?? null,
            clearState?.cleared_through ?? null,
            safeLimit
          );

        let inserted = 0;
        let skipped = 0;
        const clearedThrough = clearState ? Date.parse(clearState.cleared_through) : null;
        const insert = this.db.prepare(
          `INSERT INTO analytics_events (
             event_id, occurred_at, local_date, word_count,
             spoken_duration_ms, mode, provider, model, counter_version, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME(?))
           ON CONFLICT(event_id) DO NOTHING`
        );
        const assignClientId = this.db.prepare(
          `UPDATE transcriptions SET client_transcription_id = ?
           WHERE id = ? AND (client_transcription_id IS NULL OR TRIM(client_transcription_id) = '')`
        );

        for (const row of rows) {
          const sourceText = row.raw_text?.trim() ? row.raw_text : row.text;
          const wordCount = countSpokenWords(sourceText);
          if (wordCount === 0) {
            skipped += 1;
            continue;
          }

          const createdAt = parseDbTimestamp(row.created_at);
          // A naive timestamp is a completion time rather than an occurrence
          // time, so it is never the answer: created_at is used instead.
          const occurredAt =
            (hasExplicitTimeZone(row.timestamp) ? parseDbTimestamp(row.timestamp) : null) ??
            createdAt;
          // Guessing a date would put an old dictation on today, inflating
          // today's counters and manufacturing a current streak out of a row
          // whose age we could not read. It stays out instead.
          if (!occurredAt) {
            skipped += 1;
            continue;
          }
          // Not a restatement of the query's clear filter: that one decides
          // eligibility from transcription.timestamp, while this guards the
          // instant actually chosen, which may be created_at. It also catches
          // what the SQL shape test cannot -- a bare YYYY-MM-DD reads as zoned
          // there, its day hyphen sitting six characters from the end.
          if (clearedThrough !== null && occurredAt.getTime() <= clearedThrough) {
            skipped += 1;
            continue;
          }

          const eventId = row.client_transcription_id?.trim() || randomUUID();
          if (!row.client_transcription_id?.trim()) assignClientId.run(eventId, row.id);
          const result = insert.run(
            eventId,
            occurredAt.toISOString(),
            localDateKey(occurredAt),
            wordCount,
            Number(row.audio_duration_ms) > 0 ? Number(row.audio_duration_ms) : null,
            inferHistoricalAnalyticsMode(row.provider),
            row.provider || null,
            row.model || null,
            ANALYTICS_HISTORICAL_COUNTER_VERSION,
            (createdAt ?? occurredAt).toISOString()
          );
          if (result.changes > 0) inserted += 1;
          else skipped += 1;
        }

        const complete = rows.length < safeLimit;
        const lastCandidateId =
          rows.length > 0 ? Number(rows[rows.length - 1].id) : effectiveAfterId;
        const nextCursor = complete && safeThroughId !== null ? safeThroughId : lastCandidateId;
        if (checkpoint) {
          this.db
            .prepare(
              `UPDATE analytics_history_backfill_state
               SET scanned_through_transcription_id = ?
               WHERE id = 1 AND version = ?`
            )
            .run(nextCursor, safeCheckpointVersion);
        }

        return {
          complete,
          nextCursor,
          scanned: rows.length,
          inserted,
          skipped,
        };
      })();
    } catch (error) {
      debugLogger.error(
        "Error backfilling analytics history",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  recordAnalyticsEvent({
    eventId,
    wordCount,
    occurredAt,
    localDate,
    spokenDurationMs = null,
    mode = "unknown",
    provider = null,
    model = null,
  }) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (wordCount === 0) return { success: true, ignored: true };
      // An in-flight recording that finishes after Clear History stays cleared.
      const cleared = this.db
        .prepare(
          `SELECT 1 FROM analytics_device_clear_state
           WHERE id = 1 AND ? <= cleared_through`
        )
        .get(occurredAt);
      if (cleared) return { success: true, ignored: true };
      this.db
        .prepare(
          `INSERT INTO analytics_events (
             event_id, occurred_at, local_date, word_count,
             spoken_duration_ms, mode, provider, model, counter_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             occurred_at = excluded.occurred_at,
             local_date = excluded.local_date,
             word_count = excluded.word_count,
             spoken_duration_ms = COALESCE(
               excluded.spoken_duration_ms,
               analytics_events.spoken_duration_ms
             ),
             mode = excluded.mode,
             provider = COALESCE(excluded.provider, analytics_events.provider),
             model = COALESCE(excluded.model, analytics_events.model),
             counter_version = excluded.counter_version`
        )
        .run(
          eventId,
          occurredAt,
          localDate,
          wordCount,
          Number(spokenDurationMs) > 0 ? Number(spokenDurationMs) : null,
          mode,
          provider,
          model,
          ANALYTICS_COUNTER_VERSION
        );
      return { success: true, eventId };
    } catch (error) {
      debugLogger.error("Error recording analytics event", { error: error.message }, "database");
      throw error;
    }
  }

  getAnalyticsSummary() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // Grouped in SQL so the row count is bounded by distinct days rather than
      // by dictations; summarizeAnalyticsDays still owns every derived figure.
      const days = this.db
        .prepare(
          `SELECT local_date AS date,
                  SUM(word_count) AS words,
                  COUNT(*) AS dictations,
                  SUM(CASE WHEN spoken_duration_ms > 0 THEN spoken_duration_ms ELSE 0 END)
                    AS spokenDurationMs,
                  SUM(CASE WHEN spoken_duration_ms > 0 THEN word_count ELSE 0 END)
                    AS coveredWords
           FROM analytics_events
           GROUP BY local_date`
        )
        .all();
      return summarizeAnalyticsDays(days);
    } catch (error) {
      debugLogger.error("Error reading analytics summary", { error: error.message }, "database");
      throw error;
    }
  }

  getTranscriptions(limit = 50, { includeDiscarded = false } = {}) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const statusFilter = includeDiscarded ? "" : " WHERE status != 'discarded'";
      const stmt = this.db.prepare(
        `SELECT * FROM transcriptions${statusFilter} ORDER BY timestamp DESC LIMIT ?`
      );
      const transcriptions = stmt.all(limit);
      return transcriptions;
    } catch (error) {
      debugLogger.error("Error getting transcriptions", { error: error.message }, "database");
      throw error;
    }
  }

  clearTranscriptions() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const deleteTranscriptions = this.db.prepare("DELETE FROM transcriptions");
      const deleteAnalytics = this.db.prepare("DELETE FROM analytics_events");
      const updateDeviceClearState = this.db.prepare(
        `INSERT INTO analytics_device_clear_state (id, cleared_through)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET
           cleared_through = MAX(analytics_device_clear_state.cleared_through, excluded.cleared_through)`
      );
      const clearedThrough = new Date().toISOString();
      const clearAll = this.db.transaction(() => {
        const cleared = deleteTranscriptions.run().changes;
        updateDeviceClearState.run(clearedThrough);
        deleteAnalytics.run();
        return cleared;
      });
      return { cleared: clearAll(), success: true };
    } catch (error) {
      debugLogger.error("Error clearing transcriptions", { error: error.message }, "database");
      throw error;
    }
  }

  /** Purges transcriptions and their Insights counters older than the retention window.
   *  Returns the affected transcription ids so callers can drop the matching audio files. */
  deleteTranscriptionsExpiredBefore(retentionDays) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      // Resolve the cutoff once so the ids we report are exactly the rows we purge.
      const cutoff = this.db
        .prepare("SELECT datetime('now', ?) AS cutoff")
        .get(`-${retentionDays} days`).cutoff;
      const expired = this.db
        .prepare("SELECT id FROM transcriptions WHERE created_at < ?")
        .all(cutoff)
        .map((row) => row.id);
      // Counters follow the transcripts they describe, on the same cutoff and
      // in the same transaction. Matched on created_at, never occurred_at:
      // created_at uses the same SQLite timestamp format as the cutoff.
      const deleteTranscriptions = this.db.prepare(
        "DELETE FROM transcriptions WHERE created_at < ?"
      );
      const deleteAnalytics = this.db.prepare("DELETE FROM analytics_events WHERE created_at < ?");
      let analyticsPurged = 0;
      this.db.transaction(() => {
        deleteTranscriptions.run(cutoff);
        analyticsPurged = deleteAnalytics.run(cutoff).changes;
      })();
      return { ids: expired, analyticsPurged };
    } catch (error) {
      debugLogger.error(
        "Error purging expired transcriptions",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  deleteTranscription(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const result = this.db.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting transcription", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscriptionAudio(id, { hasAudio, audioDurationMs, provider, model }) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        "UPDATE transcriptions SET has_audio = ?, audio_duration_ms = ?, provider = ?, model = ? WHERE id = ?"
      );
      stmt.run(hasAudio, audioDurationMs, provider, model, id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating transcription audio", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscriptionText(id, text, rawText) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare("UPDATE transcriptions SET text = ?, raw_text = ? WHERE id = ?");
      this.db.transaction(() => {
        const existing = this.db
          .prepare("SELECT text, raw_text FROM transcriptions WHERE id = ?")
          .get(id);
        if (existing && (existing.text !== text || existing.raw_text !== rawText)) {
          this._invalidateAnalyticsHistoryFromTranscription(id);
        }
        stmt.run(text, rawText, id);
      })();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating transcription text", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscriptionStatus(id, status, errorMessage = null, errorCode = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare(
        "UPDATE transcriptions SET status = ?, error_message = ?, error_code = ? WHERE id = ?"
      );
      this.db.transaction(() => {
        const existing = this.db.prepare("SELECT status FROM transcriptions WHERE id = ?").get(id);
        if (existing && existing.status !== status && status === "completed") {
          this._invalidateAnalyticsHistoryFromTranscription(id);
        }
        stmt.run(status, errorMessage, errorCode, id);
      })();
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error updating transcription status",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getTranscriptionById(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const stmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      return stmt.get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting transcription by id", { error: error.message }, "database");
      throw error;
    }
  }

  clearAudioFlags(ids) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!ids || ids.length === 0) return { success: true };
      const transaction = this.db.transaction((idList) => {
        const stmt = this.db.prepare("UPDATE transcriptions SET has_audio = 0 WHERE id = ?");
        for (const id of idList) {
          stmt.run(id);
        }
      });
      transaction(ids);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing audio flags", { error: error.message }, "database");
      throw error;
    }
  }

  getDictionary() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const rows = this.db.prepare("SELECT word FROM custom_dictionary ORDER BY id ASC").all();
      return rows.map((row) => row.word);
    } catch (error) {
      debugLogger.error("Error getting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  // Every dictionary mutation rule lives here once, so the whole-list and
  // delta write paths cannot drift apart.
  _dictionaryWriteStatements() {
    return {
      delete: this.db.prepare("DELETE FROM custom_dictionary WHERE id = ?"),
      promoteSource: this.db.prepare(
        "UPDATE custom_dictionary SET word = ?, source = 'manual', updated_at = datetime('now') WHERE id = ? AND source = 'learned'"
      ),
      updateWord: this.db.prepare(
        "UPDATE custom_dictionary SET word = ?, updated_at = datetime('now') WHERE id = ? AND word != ?"
      ),
      // INSERT OR IGNORE in case a legacy case-variant row collides on the
      // case-sensitive UNIQUE(word) that the lowercase index didn't catch.
      insert: this.db.prepare(
        "INSERT OR IGNORE INTO custom_dictionary (word, source, updated_at) VALUES (?, ?, datetime('now'))"
      ),
    };
  }

  // Dedupe by lower(word), keeping the first occurrence's casing, so no caller
  // can present two spellings of the same word to a write loop.
  _normalizeDictionaryWords(words) {
    const byLower = new Map();
    for (const raw of Array.isArray(words) ? words : []) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (!byLower.has(lower)) byLower.set(lower, trimmed);
    }
    return byLower;
  }

  _dictionaryRows() {
    const rows = this.db.prepare("SELECT id, word, source FROM custom_dictionary").all();
    return { rows, byLower: new Map(rows.map((r) => [r.word.toLowerCase(), r])) };
  }

  // Returns true when the word became present, so callers can report how many
  // words they actually added rather than how many they asked for.
  _upsertDictionaryWord(stmts, word, existing, source) {
    if (!existing) {
      return stmts.insert.run(word, source).changes > 0;
    }
    if (source === "manual" && existing.source === "learned") {
      stmts.promoteSource.run(word, existing.id);
    } else {
      stmts.updateWord.run(word, existing.id, word);
    }
    return false;
  }

  _deleteDictionaryRow(stmts, existing) {
    if (!existing) return false;
    return stmts.delete.run(existing.id).changes > 0;
  }

  // Add and/or remove specific words, leaving every other row untouched.
  // Prefer this over setDictionary, which deletes whatever the caller omitted
  // and so lets a stale snapshot destroy the rest (#1295).
  // `source` tags additions ('manual' for user-typed, 'learned' for auto-learn).
  applyDictionaryChanges({ add = [], remove = [] } = {}, source = "manual") {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const additions = this._normalizeDictionaryWords(add);
      const removals = this._normalizeDictionaryWords(remove);
      // A word on both sides is a rename to itself; adding wins.
      for (const lower of additions.keys()) removals.delete(lower);
      if (additions.size === 0 && removals.size === 0) {
        return { success: true, added: 0, removed: 0 };
      }

      const { byLower } = this._dictionaryRows();
      const stmts = this._dictionaryWriteStatements();
      let added = 0;
      let removed = 0;

      this.db.transaction(() => {
        for (const lower of removals.keys()) {
          if (this._deleteDictionaryRow(stmts, byLower.get(lower))) removed += 1;
        }
        for (const [lower, word] of additions) {
          if (this._upsertDictionaryWord(stmts, word, byLower.get(lower), source)) added += 1;
        }
      })();

      return { success: true, added, removed };
    } catch (error) {
      debugLogger.error("Error applying dictionary changes", { error: error.message }, "database");
      throw error;
    }
  }

  // Replace the entire dictionary: anything absent from `words` is deleted.
  // Only for deliberate replace-everything callers (settings restore, clear
  // all, first write into an empty database). Everything else wants
  // applyDictionaryChanges.
  //
  // Diff-based so unchanged rows keep their source/created_at.
  setDictionary(words, sourceForNewWords = "manual") {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const incomingByLower = this._normalizeDictionaryWords(words);
      const { rows, byLower } = this._dictionaryRows();
      const stmts = this._dictionaryWriteStatements();

      this.db.transaction(() => {
        for (const existing of rows) {
          if (incomingByLower.has(existing.word.toLowerCase())) continue;
          this._deleteDictionaryRow(stmts, existing);
        }
        for (const [lower, word] of incomingByLower) {
          this._upsertDictionaryWord(stmts, word, byLower.get(lower), sourceForNewWords);
        }
      })();

      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  getSnippets() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      return this.db.prepare("SELECT trigger, replacement FROM snippets ORDER BY id ASC").all();
    } catch (error) {
      debugLogger.error("Error getting snippets", { error: error.message }, "database");
      throw error;
    }
  }

  setSnippets(snippets) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }

      const incomingByLower = new Map();
      for (const raw of Array.isArray(snippets) ? snippets : []) {
        if (!raw || typeof raw !== "object") continue;
        const trigger = typeof raw.trigger === "string" ? raw.trigger.trim() : "";
        const replacement = typeof raw.replacement === "string" ? raw.replacement.trim() : "";
        if (!trigger || !replacement) continue;
        if (trigger.length > MAX_SNIPPET_TRIGGER_LENGTH) continue;
        const lower = trigger.toLowerCase();
        if (!incomingByLower.has(lower)) incomingByLower.set(lower, { trigger, replacement });
      }
      const cleaned = Array.from(incomingByLower.values());
      const incomingLower = new Set(incomingByLower.keys());

      const existingRows = this.db.prepare("SELECT * FROM snippets").all();
      const existingByLower = new Map();
      for (const row of existingRows) {
        const lower = row.trigger.toLowerCase();
        if (!existingByLower.has(lower)) existingByLower.set(lower, row);
      }

      const remove = this.db.prepare("DELETE FROM snippets WHERE id = ?");
      const update = this.db.prepare(
        "UPDATE snippets SET trigger = ?, replacement = ?, updated_at = datetime('now') WHERE id = ? AND (trigger != ? OR replacement != ?)"
      );
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO snippets (trigger, replacement, updated_at) VALUES (?, ?, datetime('now'))"
      );

      this.db.transaction(() => {
        for (const existing of existingRows) {
          if (incomingLower.has(existing.trigger.toLowerCase())) continue;
          remove.run(existing.id);
        }

        for (const snippet of cleaned) {
          const existing = existingByLower.get(snippet.trigger.toLowerCase());
          if (existing) {
            update.run(
              snippet.trigger,
              snippet.replacement,
              existing.id,
              snippet.trigger,
              snippet.replacement
            );
            continue;
          }
          insert.run(snippet.trigger, snippet.replacement);
        }
      })();

      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting snippets", { error: error.message }, "database");
      throw error;
    }
  }

  saveNote(
    title,
    content,
    noteType = "personal",
    sourceFile = null,
    audioDuration = null,
    folderId = null,
    spaceId = null
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      if (folderId) {
        // D2: a note's space always follows its folder's space.
        const folder = this._getFolder(folderId);
        if (!folder) throw new Error("Folder not found");
        spaceId = folder.space_id;
      } else {
        if (spaceId == null) spaceId = this.getPrivateSpaceId();
        if (!this.getSpace(spaceId)) throw new Error("Space not found");
        const defaultFolderName = noteType === "meeting" ? "Meetings" : "Personal";
        const defaultFolder = this.db
          .prepare("SELECT id FROM folders WHERE name = ? AND is_default = 1 AND space_id = ?")
          .get(defaultFolderName, spaceId);
        folderId = defaultFolder?.id || null;
      }
      const clientNoteId = randomUUID();
      const stmt = this.db.prepare(
        "INSERT INTO notes (title, content, note_type, source_file, audio_duration_seconds, folder_id, space_id, client_note_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(
        title,
        content,
        noteType,
        sourceFile,
        audioDuration,
        folderId,
        spaceId,
        clientNoteId
      );

      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(result.lastInsertRowid);
      this._emitNoteChange({ type: "upsert", noteId: note.id });

      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error saving note", { error: error.message }, "notes");
      throw error;
    }
  }

  /**
   * Bulk-insert externally imported notes (e.g. a Granola CSV export).
   * Unlike saveNote, rows carry their own client_note_id and original
   * created_at/updated_at; the UNIQUE client_note_id index makes re-imports
   * idempotent (duplicates are skipped, never overwritten).
   */
  importNotes(rows, { noteType = "meeting", folderName = "Imported" } = {}) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const spaceId = this.getPrivateSpaceId();

      let folderId = null;
      try {
        const existing = this.db
          .prepare("SELECT id FROM folders WHERE name = ? AND space_id = ?")
          .get(folderName, spaceId);
        folderId = existing?.id ?? this.createFolder(folderName, spaceId)?.folder?.id ?? null;
      } catch (folderError) {
        debugLogger.error(
          "Import folder resolution failed; importing without a folder",
          { error: folderError.message },
          "notes"
        );
      }

      const insert = this.db.prepare(`
        INSERT INTO notes (client_note_id, title, content, note_type, source_file,
          folder_id, space_id, transcript, participants, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
        ON CONFLICT(client_note_id) DO NOTHING
      `);

      let imported = 0;
      let skipped = 0;
      const noteIds = [];
      const errors = [];
      this.db.transaction(() => {
        for (const row of rows) {
          try {
            const result = insert.run(
              row.clientNoteId,
              row.title,
              row.content,
              noteType,
              row.sourceFile,
              folderId,
              spaceId,
              row.transcript,
              row.participants,
              row.createdAt,
              row.createdAt
            );
            if (result.changes === 1) {
              imported++;
              noteIds.push(Number(result.lastInsertRowid));
            } else {
              skipped++;
            }
          } catch (rowError) {
            errors.push({ clientNoteId: row.clientNoteId, error: rowError.message });
          }
        }
      })();
      for (const noteId of noteIds) this._emitNoteChange({ type: "upsert", noteId });

      return { success: true, imported, skipped, folderId, noteIds, errors };
    } catch (error) {
      debugLogger.error("Error importing notes", { error: error.message }, "notes");
      throw error;
    }
  }

  getExistingClientNoteIds(clientNoteIds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const existing = [];
      for (let i = 0; i < clientNoteIds.length; i += 500) {
        const chunk = clientNoteIds.slice(i, i + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const found = this.db
          .prepare(`SELECT client_note_id FROM notes WHERE client_note_id IN (${placeholders})`)
          .all(...chunk);
        existing.push(...found.map((row) => row.client_note_id));
      }
      return existing;
    } catch (error) {
      debugLogger.error("Error checking client note ids", { error: error.message }, "notes");
      throw error;
    }
  }

  getNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting note", { error: error.message }, "notes");
      throw error;
    }
  }

  getNotes(noteType = null, limit = 100, folderId = null, spaceId = null) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const conditions = [];
      const params = [];
      if (noteType) {
        conditions.push("note_type = ?");
        params.push(noteType);
      }
      if (folderId != null) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      } else if (spaceId != null) {
        // spaceId without folderId lists a space's root: folderless notes only.
        conditions.push("folder_id IS NULL");
      }
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const stmt = this.db.prepare(`SELECT * FROM notes ${where} ORDER BY updated_at DESC LIMIT ?`);
      params.push(limit);
      return stmt.all(...params);
    } catch (error) {
      debugLogger.error("Error getting notes", { error: error.message }, "notes");
      throw error;
    }
  }

  // Unlike getNotes(null, limit, null, spaceId) — which is root-only — this
  // lists every note in the space, foldered or not (space overview list).
  getNotesForSpace(spaceId, limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT * FROM notes WHERE space_id = ? ORDER BY updated_at DESC LIMIT ?")
        .all(spaceId, limit);
    } catch (error) {
      debugLogger.error("Error getting notes for space", { error: error.message }, "notes");
      throw error;
    }
  }

  getNoteIdsInFolder(folderId) {
    return this.getNoteIdsInScope(null, folderId);
  }

  // Authoritative scope membership for semantic-search candidates. Qdrant
  // payload writes are asynchronous/best-effort, so its filters are only an
  // optimization and must not decide which space or folder a hit belongs to.
  getNoteIdsInScope(spaceId = null, folderId = null, candidateIds = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (candidateIds && candidateIds.length === 0) return [];
      const conditions = [];
      const params = [];
      if (candidateIds) {
        conditions.push(`id IN (${candidateIds.map(() => "?").join(", ")})`);
        params.push(...candidateIds);
      }
      if (spaceId != null) {
        conditions.push("space_id = ?");
        params.push(spaceId);
      }
      if (folderId != null) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      return this.db
        .prepare(`SELECT id FROM notes${where}`)
        .all(...params)
        .map((row) => row.id);
    } catch (error) {
      debugLogger.error("Error getting scoped note ids", { error: error.message }, "notes");
      throw error;
    }
  }

  updateNote(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(id)) return { success: false, error: "Note not found" };
      updates = { ...updates };
      if (updates.folder_id != null) {
        // D2: a note's space always follows its folder's space.
        const folder = this._getFolder(updates.folder_id);
        if (folder) updates = { ...updates, space_id: folder.space_id };
        else return { success: false, error: "Folder not found" };
      }
      if (updates.space_id !== undefined && !this.getSpace(updates.space_id)) {
        return { success: false, error: "Space not found" };
      }
      const allowedFields = [
        "title",
        "content",
        "enhanced_content",
        "enhancement_prompt",
        "enhanced_at_content_hash",
        "folder_id",
        "space_id",
        "transcript",
        "calendar_event_id",
        "participants",
        "diarization_enabled",
        "expected_speaker_count",
        "client_note_id",
      ];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return { success: false };
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      const result = this.db
        .prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`)
        .run(...values);
      if (result.changes === 0) return { success: false, error: "Note not found" };
      const note = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
      this._emitNoteChange({ type: "upsert", noteId: id });
      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error updating note", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolders(spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const where = spaceId != null ? " WHERE space_id = ?" : "";
      const params = spaceId != null ? [spaceId] : [];
      return this.db
        .prepare(`SELECT * FROM folders${where} ORDER BY sort_order ASC, created_at ASC`)
        .all(...params);
    } catch (error) {
      debugLogger.error("Error getting folders", { error: error.message }, "notes");
      throw error;
    }
  }

  createFolder(name, spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      if (spaceId == null) spaceId = this.getPrivateSpaceId();
      if (!this.getSpace(spaceId)) {
        return { success: false, error: "Space not found" };
      }
      const existing = this.db
        .prepare("SELECT id FROM folders WHERE name = ? AND space_id = ?")
        .get(trimmed, spaceId);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      const maxOrder = this.db
        .prepare("SELECT MAX(sort_order) as max_order FROM folders WHERE space_id = ?")
        .get(spaceId);
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const result = this.db
        .prepare("INSERT INTO folders (name, sort_order, space_id) VALUES (?, ?, ?)")
        .run(trimmed, sortOrder, spaceId);
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, folder };
    } catch (error) {
      debugLogger.error("Error creating folder", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteFolder(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this._getFolder(id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot delete default folders" };
      const childNotes = "SELECT id FROM notes WHERE folder_id = ?";
      const childRows = this.db
        .prepare("SELECT id, client_note_id FROM notes WHERE folder_id = ?")
        .all(id);
      const noteIds = childRows.map((row) => row.id);
      this.db.transaction(() => {
        this._deleteConversationsWhere(`note_id IN (${childNotes})`, [id]);
        this._deleteSpeakerRowsForNotes(childNotes, id);
        this.db.prepare("DELETE FROM notes WHERE folder_id = ?").run(id);
        this._deleteConversationsWhere("folder_id = ?", [id]);
        this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
      })();
      for (const row of childRows) {
        this._emitNoteChange({ type: "delete", noteId: row.id, clientNoteId: row.client_note_id });
      }
      this._emitNoteChange({ type: "folder-vacated", name: folder.name });
      return { success: true, id, noteIds, name: folder.name };
    } catch (error) {
      debugLogger.error("Error deleting folder", { error: error.message }, "notes");
      throw error;
    }
  }

  renameFolder(id, name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this._getFolder(id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot rename default folders" };
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      const existing = this.db
        .prepare("SELECT id FROM folders WHERE name = ? AND space_id = ? AND id != ?")
        .get(trimmed, folder.space_id, id);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      this.db
        .prepare("UPDATE folders SET name = ?, updated_at = datetime('now') WHERE id = ?")
        .run(trimmed, id);
      const updated = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      if (trimmed !== folder.name) {
        for (const row of this.db.prepare("SELECT id FROM notes WHERE folder_id = ?").all(id)) {
          this._emitNoteChange({ type: "upsert", noteId: row.id });
        }
        this._emitNoteChange({ type: "folder-vacated", name: folder.name });
      }
      return { success: true, folder: updated };
    } catch (error) {
      debugLogger.error("Error renaming folder", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolderNoteCounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      // folder_id NULL rows are space-root notes; grouping by space_id too
      // attributes them per space so the tree shows true space totals.
      return this.db
        .prepare(
          `SELECT space_id, folder_id, COUNT(*) as count
           FROM notes
           GROUP BY space_id, folder_id`
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting folder note counts", { error: error.message }, "notes");
      throw error;
    }
  }

  getPrivateSpaceId() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT id FROM spaces WHERE kind = 'private'").get()?.id ?? null;
    } catch (error) {
      debugLogger.error("Error getting private space id", { error: error.message }, "spaces");
      throw error;
    }
  }

  getSpaces() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT * FROM spaces
           ORDER BY CASE WHEN kind = 'private' THEN 0 ELSE 1 END, sort_order ASC, name ASC`
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting spaces", { error: error.message }, "spaces");
      throw error;
    }
  }

  getSpace(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting space", { error: error.message }, "spaces");
      throw error;
    }
  }

  // Speaker rows cascade on note delete (ON DELETE CASCADE), but only while
  // foreign_keys is on, so deletes clear them explicitly.
  _deleteSpeakerRowsForNotes(noteIdSubquery, ...params) {
    this.db
      .prepare(`DELETE FROM speaker_mappings WHERE note_id IN (${noteIdSubquery})`)
      .run(...params);
    this.db
      .prepare(`DELETE FROM note_speaker_embeddings WHERE note_id IN (${noteIdSubquery})`)
      .run(...params);
  }

  // Conversations whose note or container is being removed must not survive
  // as global chats.
  _deleteConversationsWhere(filter, params) {
    this.db
      .prepare(
        `DELETE FROM agent_messages WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE ${filter})`
      )
      .run(...params);
    this.db.prepare(`DELETE FROM agent_conversations WHERE ${filter}`).run(...params);
  }

  _initVectorChangeJournal() {
    this.db.transaction(() => {
      const journalExists = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_vector_changes'"
        )
        .get();
      // AUTOINCREMENT keeps acknowledgements unique even after the queue is
      // emptied or a deleted note id is reused while indexing is in flight.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_vector_changes (
          revision INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id INTEGER NOT NULL UNIQUE
        );
        CREATE TRIGGER IF NOT EXISTS notes_vector_insert AFTER INSERT ON notes BEGIN
          INSERT INTO pending_vector_changes (note_id) VALUES (NEW.id)
          ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
        END;
        CREATE TRIGGER IF NOT EXISTS notes_vector_update
        AFTER UPDATE OF title, content, enhanced_content, space_id, folder_id, deleted_at ON notes
        WHEN OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content
          OR OLD.enhanced_content IS NOT NEW.enhanced_content
          OR OLD.space_id IS NOT NEW.space_id OR OLD.folder_id IS NOT NEW.folder_id
          OR OLD.deleted_at IS NOT NEW.deleted_at
        BEGIN
          INSERT INTO pending_vector_changes (note_id) VALUES (NEW.id)
          ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
        END;
        CREATE TRIGGER IF NOT EXISTS notes_vector_delete AFTER DELETE ON notes BEGIN
          INSERT INTO pending_vector_changes (note_id) VALUES (OLD.id)
          ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision;
        END;
      `);
      if (!journalExists) this.enqueueAllVectorChanges();
    })();
  }

  getPendingVectorChanges(limit = 50, afterRevision = 0) {
    if (!this.db) throw new Error("Database not initialized");
    return this.db
      .prepare(
        "SELECT note_id, revision FROM pending_vector_changes WHERE revision > ? ORDER BY revision LIMIT ?"
      )
      .all(afterRevision, limit);
  }

  clearPendingVectorChange(noteId, revision) {
    if (!this.db) throw new Error("Database not initialized");
    const result = this.db
      .prepare("DELETE FROM pending_vector_changes WHERE note_id = ? AND revision = ?")
      .run(noteId, revision);
    return { success: true, changes: result.changes };
  }

  enqueueAllVectorChanges() {
    if (!this.db) throw new Error("Database not initialized");
    this.db.exec(`
      INSERT INTO pending_vector_changes (note_id) SELECT id FROM notes WHERE TRUE
      ON CONFLICT(note_id) DO UPDATE SET revision = excluded.revision
    `);
    return { success: true };
  }

  getNoteForVectorIndex(noteId) {
    if (!this.db) throw new Error("Database not initialized");
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) || null;
  }

  getPendingVectorPurges() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT space_id FROM pending_vector_purges").all();
    } catch (error) {
      debugLogger.error("Error getting pending vector purges", { error: error.message }, "spaces");
      throw error;
    }
  }

  clearPendingVectorPurge(spaceId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM pending_vector_purges WHERE space_id = ?").run(spaceId);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing pending vector purge", { error: error.message }, "spaces");
      throw error;
    }
  }

  getActions() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM actions ORDER BY sort_order ASC, created_at ASC").all();
    } catch (error) {
      debugLogger.error("Error getting actions", { error: error.message }, "notes");
      throw error;
    }
  }

  getAction(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting action", { error: error.message }, "notes");
      throw error;
    }
  }

  createAction(name, description, prompt, icon = "sparkles") {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmedName = (name || "").trim();
      const trimmedPrompt = (prompt || "").trim();
      if (!trimmedName) return { success: false, error: "Action name is required" };
      if (!trimmedPrompt) return { success: false, error: "Action prompt is required" };
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) as max_order FROM actions").get();
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const result = this.db
        .prepare(
          "INSERT INTO actions (name, description, prompt, icon, sort_order) VALUES (?, ?, ?, ?, ?)"
        )
        .run(trimmedName, (description || "").trim(), trimmedPrompt, icon || "sparkles", sortOrder);
      const action = this.db
        .prepare("SELECT * FROM actions WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, action };
    } catch (error) {
      debugLogger.error("Error creating action", { error: error.message }, "notes");
      throw error;
    }
  }

  updateAction(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const allowedFields = ["name", "description", "prompt", "icon", "sort_order"];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return { success: false };
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      this.db.prepare(`UPDATE actions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      const action = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
      return { success: true, action };
    } catch (error) {
      debugLogger.error("Error updating action", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteAction(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const action = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
      if (!action) return { success: false, error: "Action not found" };
      if (action.is_builtin) return { success: false, error: "Cannot delete built-in actions" };
      this.db.prepare("DELETE FROM actions WHERE id = ?").run(id);
      return { success: true, id };
    } catch (error) {
      debugLogger.error("Error deleting action", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const existing = this.db.prepare("SELECT client_note_id FROM notes WHERE id = ?").get(id);
      const result = this.db.transaction(() => {
        this._deleteConversationsWhere("note_id = ?", [id]);
        this._deleteSpeakerRowsForNotes("SELECT ?", id);
        return this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
      })();
      if (result.changes > 0) {
        this._emitNoteChange({
          type: "delete",
          noteId: id,
          clientNoteId: existing?.client_note_id ?? null,
        });
      }
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting note", { error: error.message }, "notes");
      throw error;
    }
  }

  createAgentConversation(title = "Untitled", noteId = null, spaceId = null, folderId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        let note = null;
        let space = null;
        let folder = null;

        if (noteId != null) {
          note = this.getNote(noteId);
          if (!note) return null;
          if (note.folder_id != null) {
            const noteFolder = this._getFolder(note.folder_id);
            if (!noteFolder || noteFolder.space_id !== note.space_id) {
              return null;
            }
          }
        }
        if (spaceId != null) {
          space = this.getSpace(spaceId);
          if (!space) return null;
        }
        if (folderId != null) {
          folder = this._getFolder(folderId);
          if (!folder || !this.getSpace(folder.space_id)) return null;
        }
        if (folder && spaceId != null && folder.space_id !== spaceId) return null;
        if (note && spaceId != null && note.space_id !== spaceId) return null;
        if (note && folderId != null && note.folder_id !== folderId) return null;

        const result = this.db
          .prepare(
            "INSERT INTO agent_conversations (title, note_id, space_id, folder_id) VALUES (?, ?, ?, ?)"
          )
          .run(title, noteId, spaceId, folderId);
        return this.db
          .prepare("SELECT * FROM agent_conversations WHERE id = ?")
          .get(result.lastInsertRowid);
      })();
    } catch (error) {
      debugLogger.error("Error creating agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  getConversationsForNote(noteId, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return [];
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id) AS message_count
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          WHERE c.note_id = ?
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?`
        )
        .all(noteId, limit);
    } catch (error) {
      debugLogger.error(
        "Error getting conversations for note",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  // Space-root scope (folderId null) intentionally excludes folder-scoped
  // conversations — each container surfaces only its own chats.
  getConversationsForContainer(spaceId, folderId = null, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (folderId != null) {
        const folder = this._getFolder(folderId);
        if (!folder) return [];
      } else if (!this.getSpace(spaceId)) {
        return [];
      }
      const scopeFilter =
        folderId != null ? "c.folder_id = ?" : "c.space_id = ? AND c.folder_id IS NULL";
      const params = folderId != null ? [folderId, limit] : [spaceId, limit];
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at,
            COUNT(m.id) AS message_count
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          WHERE ${scopeFilter}
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?`
        )
        .all(...params);
    } catch (error) {
      debugLogger.error(
        "Error getting conversations for container",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getAgentConversations(limit = 50) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT * FROM agent_conversations WHERE space_id IS NULL AND folder_id IS NULL ORDER BY updated_at DESC LIMIT ?"
        )
        .all(limit);
    } catch (error) {
      debugLogger.error("Error getting agent conversations", { error: error.message }, "database");
      throw error;
    }
  }

  getAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const conversation = this.db
        .prepare("SELECT * FROM agent_conversations WHERE id = ?")
        .get(id);
      if (!conversation) return null;
      const messages = this.db
        .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(id);
      return { ...conversation, messages };
    } catch (error) {
      debugLogger.error("Error getting agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  deleteAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db.transaction(() => {
        this.db.prepare("DELETE FROM agent_messages WHERE conversation_id = ?").run(id);
        return this.db.prepare("DELETE FROM agent_conversations WHERE id = ?").run(id);
      })();
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error deleting agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  updateAgentConversationTitle(id, title) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare(
          "UPDATE agent_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(title, id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error(
        "Error updating agent conversation title",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  addAgentMessage(conversationId, role, content, metadata) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.transaction(() => {
        const conversation = this.db
          .prepare("SELECT id FROM agent_conversations WHERE id = ?")
          .get(conversationId);
        if (!conversation) return null;

        const metadataStr = metadata ? JSON.stringify(metadata) : null;
        const result = this.db
          .prepare(
            "INSERT INTO agent_messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)"
          )
          .run(conversationId, role, content, metadataStr);
        this.db
          .prepare("UPDATE agent_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(conversationId);
        return this.db
          .prepare("SELECT * FROM agent_messages WHERE id = ?")
          .get(result.lastInsertRowid);
      })();
    } catch (error) {
      debugLogger.error("Error adding agent message", { error: error.message }, "database");
      throw error;
    }
  }

  getAgentMessages(conversationId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(conversationId);
    } catch (error) {
      debugLogger.error("Error getting agent messages", { error: error.message }, "database");
      throw error;
    }
  }

  upsertCalendarEvents(events) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((eventList) => {
        const stmt = this.db.prepare(
          "INSERT OR REPLACE INTO calendar_events (id, calendar_id, provider, summary, start_time, end_time, is_all_day, status, availability_status, self_response_status, hangout_link, conference_data, organizer_email, attendees_count, attendees, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
        );
        for (const e of eventList) {
          stmt.run(
            e.id,
            e.calendar_id,
            e.provider || "apple",
            e.summary || null,
            e.start_time,
            e.end_time,
            e.is_all_day ? 1 : 0,
            e.status || "confirmed",
            e.availability_status || "unknown",
            e.self_response_status || "unknown",
            e.hangout_link || null,
            e.conference_data || null,
            e.organizer_email || null,
            e.attendees_count || 0,
            e.attendees || null
          );
        }
      });
      transaction(events);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting calendar events", { error: error.message }, "calendar");
      throw error;
    }
  }

  getActiveEvents() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          calendarEventsQuery(
            "datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now') AND is_all_day = 0 AND status IN ('confirmed', 'tentative')"
          )
        )
        .all();
    } catch (error) {
      debugLogger.error("Error getting active events", { error: error.message }, "calendar");
      throw error;
    }
  }

  searchNotes(query, limit = 50, spaceId = null, folderId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const ftsQuery = buildNoteSearchQuery(query);
      if (!ftsQuery) return [];
      const params = [ftsQuery];
      let scopeFilter = "";
      if (spaceId != null) {
        scopeFilter += " AND n.space_id = ?";
        params.push(spaceId);
      }
      if (folderId != null) {
        scopeFilter += " AND n.folder_id = ?";
        params.push(folderId);
      }
      params.push(limit);
      return this.db
        .prepare(
          `
        SELECT n.*
        FROM notes n
        JOIN notes_fts ON notes_fts.rowid = n.id
        WHERE notes_fts MATCH ?${scopeFilter}
        ORDER BY notes_fts.rank
        LIMIT ?
      `
        )
        .all(...params);
    } catch (error) {
      debugLogger.error("Error searching notes", { error: error.message }, "database");
      throw error;
    }
  }

  getUpcomingEvents(windowMinutes = 1440) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          calendarEventsQuery(
            "((datetime(start_time) > datetime('now') AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')) OR (datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now'))) AND is_all_day = 0 AND status IN ('confirmed', 'tentative')"
          )
        )
        .all(windowMinutes);
    } catch (error) {
      debugLogger.error("Error getting upcoming events", { error: error.message }, "calendar");
      throw error;
    }
  }

  getCalendarEventsInRange(start, end, providers) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const rangeStart = Date.parse(start);
      const rangeEnd = Date.parse(end);
      if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) {
        throw new RangeError("Invalid calendar event range");
      }

      const selectedProviders = [...new Set(providers)].filter((provider) =>
        AVAILABILITY_PROVIDERS.has(provider)
      );
      if (selectedProviders.length === 0) return [];
      const placeholders = selectedProviders.map(() => "?").join(", ");
      const events = this.db
        .prepare(
          calendarEventsQuery(
            `provider IN (${placeholders}) AND status IN ('confirmed', 'tentative') AND ${SELECTED_CALENDAR_EVENT_FILTER}`
          )
        )
        .all(...selectedProviders);

      return events.filter((event) => {
        const isAllDay = event.is_all_day === true || event.is_all_day === 1;
        const eventStart = parseEventTime(event.start_time, isAllDay);
        const eventEnd = parseEventTime(event.end_time, isAllDay);
        return (
          Number.isFinite(eventStart) &&
          Number.isFinite(eventEnd) &&
          eventStart < rangeEnd &&
          eventEnd > rangeStart
        );
      });
    } catch (error) {
      debugLogger.error(
        "Error getting calendar events in range",
        { error: error.message },
        "calendar"
      );
      throw error;
    }
  }

  getCalendarEventById(eventId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(eventId) || null;
    } catch (error) {
      debugLogger.error("Error getting calendar event by id", { error: error.message }, "calendar");
      return null;
    }
  }

  getNoteByCalendarEventId(eventId, excludeNoteId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const base = "SELECT * FROM notes WHERE calendar_event_id = ?";
      if (excludeNoteId) {
        return this.db.prepare(`${base} AND id != ? LIMIT 1`).get(eventId, excludeNoteId) || null;
      }
      return this.db.prepare(`${base} LIMIT 1`).get(eventId) || null;
    } catch (error) {
      debugLogger.error(
        "Error getting note by calendar event id",
        { error: error.message },
        "notes"
      );
      return null;
    }
  }

  upsertContacts(contacts) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        const stmt = this.db.prepare(
          "INSERT INTO contacts (email, display_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, contacts.display_name), updated_at = CURRENT_TIMESTAMP"
        );
        for (const c of list) {
          if (c.email) stmt.run(c.email.toLowerCase().trim(), c.displayName || null);
        }
      });
      transaction(contacts);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error upserting contacts", { error: error.message }, "database");
      throw error;
    }
  }

  searchContacts(query) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const pattern = `%${query || ""}%`;
      return this.db
        .prepare(
          "SELECT * FROM contacts WHERE email LIKE ? OR display_name LIKE ? ORDER BY display_name ASC, email ASC LIMIT 20"
        )
        .all(pattern, pattern);
    } catch (error) {
      debugLogger.error("Error searching contacts", { error: error.message }, "database");
      throw error;
    }
  }

  saveAppleCalendars(calendars) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        // Snapshots are complete: prune calendars removed from Calendar.app,
        // upsert the rest so created_at survives.
        if (list.length === 0) {
          this.db.prepare("DELETE FROM apple_calendars").run();
          return;
        }
        const placeholders = list.map(() => "?").join(", ");
        this.db
          .prepare(`DELETE FROM apple_calendars WHERE id NOT IN (${placeholders})`)
          .run(...list.map((cal) => cal.id));

        const stmt = this.db.prepare(
          `INSERT INTO apple_calendars (id, title, color, source_name)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             color = excluded.color,
             source_name = excluded.source_name`
        );
        for (const cal of list) {
          stmt.run(cal.id, cal.title, cal.color || null, cal.source_name || null);
        }
      });
      transaction(calendars);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error saving Apple calendars", { error: error.message }, "acal");
      throw error;
    }
  }

  getAppleCalendars() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM apple_calendars").all();
    } catch (error) {
      debugLogger.error("Error getting Apple calendars", { error: error.message }, "acal");
      throw error;
    }
  }

  // Snapshots cover the full current/future window, so missing unreferenced
  // events can be removed while note-linked history is retained.
  replaceAppleCalendarEvents(events) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction((list) => {
        // The helper snapshot only contains current/future events. Keep past or
        // rescheduled rows that are still referenced by meeting notes so those
        // notes retain their calendar metadata.
        this.db
          .prepare(
            `DELETE FROM calendar_events
             WHERE provider = 'apple'
               AND id NOT IN (
                 SELECT calendar_event_id
                 FROM notes
                 WHERE calendar_event_id IS NOT NULL
               )`
          )
          .run();
        if (list.length > 0) this.upsertCalendarEvents(list);
      });
      transaction(events);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error replacing Apple calendar events", { error: error.message }, "acal");
      throw error;
    }
  }

  clearAppleCalendarData() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const transaction = this.db.transaction(() => {
        this.db.prepare("DELETE FROM calendar_events WHERE provider = 'apple'").run();
        this.db.prepare("DELETE FROM apple_calendars").run();
      });
      transaction();
      return { success: true };
    } catch (error) {
      debugLogger.error("Error clearing Apple calendar data", { error: error.message }, "acal");
      throw error;
    }
  }

  getMeetingsFolder(spaceId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return (
        this.db
          .prepare(
            "SELECT id FROM folders WHERE name = 'Meetings' AND is_default = 1 AND space_id = ?"
          )
          .get(spaceId ?? this.getPrivateSpaceId()) || null
      );
    } catch (error) {
      debugLogger.error("Error getting meetings folder", { error: error.message }, "calendar");
      throw error;
    }
  }

  cleanup() {
    try {
      if (this.db) {
        try {
          this.db.close();
        } catch (closeError) {
          debugLogger.error("Error closing database", { error: closeError.message }, "database");
        }
        this.db = null;
      }
      const dbPath = path.join(
        app.getPath("userData"),
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
      );
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    } catch (error) {
      debugLogger.error("Error deleting database file", { error: error.message }, "database");
    }
  }
  getAgentConversationsWithPreview(limit = 50, offset = 0, includeArchived = false) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const archiveFilter = includeArchived
        ? "WHERE c.archived_at IS NOT NULL AND c.space_id IS NULL AND c.folder_id IS NULL"
        : "WHERE c.archived_at IS NULL AND c.space_id IS NULL AND c.folder_id IS NULL";
      return this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at, c.archived_at,
            COUNT(m.id) AS message_count,
            (SELECT content FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT role FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_role
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          ${archiveFilter}
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ? OFFSET ?`
        )
        .all(limit, offset);
    } catch (error) {
      debugLogger.error(
        "Error getting agent conversations with preview",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  searchAgentConversations(query, limit = 20) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const pattern = `%${query}%`;
      return this.db
        .prepare(
          `SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.archived_at,
            COUNT(m.id) AS message_count,
            (SELECT content FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT role FROM agent_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_role
          FROM agent_conversations c
          LEFT JOIN agent_messages m ON m.conversation_id = c.id
          LEFT JOIN agent_messages ms ON ms.conversation_id = c.id
          WHERE c.archived_at IS NULL
            AND c.space_id IS NULL AND c.folder_id IS NULL
            AND (c.title LIKE ? OR ms.content LIKE ?)
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?`
        )
        .all(pattern, pattern, limit);
    } catch (error) {
      debugLogger.error(
        "Error searching agent conversations",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  archiveAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare("UPDATE agent_conversations SET archived_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error("Error archiving agent conversation", { error: error.message }, "database");
      throw error;
    }
  }

  unarchiveAgentConversation(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare("UPDATE agent_conversations SET archived_at = NULL WHERE id = ?")
        .run(id);
      return { success: result.changes > 0 };
    } catch (error) {
      debugLogger.error(
        "Error unarchiving agent conversation",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  _normalizeEmail(email) {
    const trimmed = (email || "").trim().toLowerCase();
    return trimmed || null;
  }

  _findProfileByEmail(email) {
    const normalized = this._normalizeEmail(email);
    if (!normalized) return null;
    return this.db.prepare("SELECT * FROM speaker_profiles WHERE lower(email) = ?").get(normalized);
  }

  upsertSpeakerProfile(name, email, embeddingBuffer, profileId = null) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedEmail = this._normalizeEmail(email);
      let existing = profileId
        ? this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId)
        : null;
      if (!existing && normalizedEmail) {
        existing = this._findProfileByEmail(normalizedEmail);
      }
      if (!existing) {
        existing = this.db
          .prepare("SELECT * FROM speaker_profiles WHERE display_name = ?")
          .get(name);
      }
      if (existing) {
        const stored = new Float32Array(
          existing.embedding.buffer,
          existing.embedding.byteOffset,
          existing.embedding.byteLength / 4
        );
        const incoming = new Float32Array(
          embeddingBuffer.buffer,
          embeddingBuffer.byteOffset,
          embeddingBuffer.byteLength / 4
        );
        const updated = new Float32Array(stored.length);
        for (let i = 0; i < stored.length; i++) {
          updated[i] = 0.3 * incoming[i] + 0.7 * stored[i];
        }
        const updatedBuf = Buffer.from(updated.buffer);
        const finalEmail = normalizedEmail || existing.email || null;
        this.db
          .prepare(
            "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = sample_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(name, finalEmail, updatedBuf, existing.id);
        const resolved = this.db
          .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
          .get(existing.id);
        if (normalizedEmail) {
          const collision = this.db
            .prepare("SELECT * FROM speaker_profiles WHERE lower(email) = ? AND id != ?")
            .get(normalizedEmail, existing.id);
          if (collision) {
            return this.mergeSpeakerProfiles(resolved, collision);
          }
        }
        return resolved;
      }
      const result = this.db
        .prepare("INSERT INTO speaker_profiles (display_name, email, embedding) VALUES (?, ?, ?)")
        .run(name, normalizedEmail, embeddingBuffer);
      return this.db
        .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
        .get(result.lastInsertRowid);
    } catch (error) {
      debugLogger.error("Error upserting speaker profile", { error: error.message }, "database");
      throw error;
    }
  }

  attachEmailToProfile(profileId, email) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalizedEmail = this._normalizeEmail(email);
      const profile = this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
      if (!profile) throw new Error(`Speaker profile ${profileId} not found`);

      if (!normalizedEmail) {
        this.db
          .prepare(
            "UPDATE speaker_profiles SET email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(profileId);
        return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
      }

      const collision = this._findProfileByEmail(normalizedEmail);
      if (collision && collision.id !== profileId) {
        return this.mergeSpeakerProfiles(collision, profile);
      }

      this.db
        .prepare(
          "UPDATE speaker_profiles SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(normalizedEmail, profileId);
      return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId);
    } catch (error) {
      debugLogger.error(
        "Error attaching email to speaker profile",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  mergeSpeakerProfiles(a, b) {
    const winner = (a.sample_count || 0) >= (b.sample_count || 0) ? a : b;
    const loser = winner === a ? b : a;

    const winnerEmb = new Float32Array(
      winner.embedding.buffer,
      winner.embedding.byteOffset,
      winner.embedding.byteLength / 4
    );
    const loserEmb = new Float32Array(
      loser.embedding.buffer,
      loser.embedding.byteOffset,
      loser.embedding.byteLength / 4
    );
    const wSamples = winner.sample_count || 1;
    const lSamples = loser.sample_count || 1;
    const total = wSamples + lSamples;
    const blended = new Float32Array(winnerEmb.length);
    for (let i = 0; i < winnerEmb.length; i++) {
      blended[i] = (winnerEmb[i] * wSamples + loserEmb[i] * lSamples) / total;
    }

    const finalEmail = winner.email || loser.email || null;
    const finalName = winner.display_name || loser.display_name;
    const affectedNotes = this.db
      .prepare("SELECT DISTINCT note_id FROM speaker_mappings WHERE profile_id = ?")
      .all(loser.id);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, sample_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(finalName, finalEmail, Buffer.from(blended.buffer), total, winner.id);
      this.db
        .prepare(
          "UPDATE speaker_mappings SET profile_id = ?, display_name = ? WHERE profile_id = ?"
        )
        .run(winner.id, finalName, loser.id);
      this.db.prepare("DELETE FROM speaker_profiles WHERE id = ?").run(loser.id);
    });
    tx();
    for (const row of affectedNotes) this._emitNoteChange({ type: "upsert", noteId: row.note_id });

    return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(winner.id);
  }

  getSpeakerProfiles(includeEmbedding = false) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const query = includeEmbedding
        ? "SELECT * FROM speaker_profiles"
        : `SELECT id, display_name, email, sample_count, created_at, updated_at
           FROM speaker_profiles`;
      return this.db.prepare(query).all();
    } catch (error) {
      debugLogger.error("Error getting speaker profiles", { error: error.message }, "database");
      throw error;
    }
  }

  setSpeakerMapping(noteId, speakerId, profileId, displayName) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return { success: false, error: "Note not found" };
      this.db
        .prepare(
          "INSERT OR REPLACE INTO speaker_mappings (note_id, speaker_id, profile_id, display_name) VALUES (?, ?, ?, ?)"
        )
        .run(noteId, speakerId, profileId, displayName);
      this._emitNoteChange({ type: "upsert", noteId });
      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting speaker mapping", { error: error.message }, "database");
      throw error;
    }
  }

  getSpeakerMappings(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return [];
      return this.db.prepare("SELECT * FROM speaker_mappings WHERE note_id = ?").all(noteId);
    } catch (error) {
      debugLogger.error("Error getting speaker mappings", { error: error.message }, "database");
      throw error;
    }
  }

  saveNoteSpeakerEmbeddings(noteId, embeddings) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return { success: false, error: "Note not found" };
      const transaction = this.db.transaction((entries) => {
        const stmt = this.db.prepare(
          "INSERT OR REPLACE INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
        );
        for (const [speakerId, buffer] of entries) {
          stmt.run(noteId, speakerId, buffer);
        }
      });
      transaction(Object.entries(embeddings));
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Error saving note speaker embeddings",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getNoteSpeakerEmbeddings(noteId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return [];
      return this.db.prepare("SELECT * FROM note_speaker_embeddings WHERE note_id = ?").all(noteId);
    } catch (error) {
      debugLogger.error(
        "Error getting note speaker embeddings",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  getNotesWithUnmappedSpeakers() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          `SELECT DISTINCT nse.note_id
          FROM note_speaker_embeddings nse
          JOIN notes ON notes.id = nse.note_id
          LEFT JOIN speaker_mappings sm ON nse.note_id = sm.note_id AND nse.speaker_id = sm.speaker_id
          WHERE sm.note_id IS NULL`
        )
        .all()
        .map((row) => row.note_id);
    } catch (error) {
      debugLogger.error(
        "Error getting notes with unmapped speakers",
        { error: error.message },
        "database"
      );
      throw error;
    }
  }

  removeSpeakerMapping(noteId, speakerId) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!this.getNote(noteId)) return { success: false };
      this.db
        .prepare("DELETE FROM speaker_mappings WHERE note_id = ? AND speaker_id = ?")
        .run(noteId, speakerId);
      this._emitNoteChange({ type: "upsert", noteId });
      return { success: true };
    } catch (error) {
      debugLogger.error("Error removing speaker mapping", { error: error.message }, "database");
      throw error;
    }
  }
}

module.exports = DatabaseManager;
