// Pure parsing for the note-files import (noteFilesSync.js): turns the files
// the mirror exports (noteExportFormat.js), possibly on another computer
// sharing the vault, back into note fields. No filesystem access.
const { NOTES_MARKER, parseFrontmatter, unquoteYaml } = require("./noteExportFormat");

const FRONTMATTER = /^\uFEFF?---\n([\s\S]*?)\n---(?:\n|$)/;
const RELATED_LINE = /^Related: \[\[[^\]\n]*\]\]\n*/;
const SOURCE_LINE = /\n*Source: \[\[[^\]\n]*\]\]$/;
const TURN_HEADER = /^\*\*(.+)\*\* `(\d+):(\d{2}):(\d{2})`$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const NOTE_TYPE = /^[a-z][a-z_-]*$/;
// formatMdTurns prints a stray absolute epoch timestamp as a huge offset;
// nothing past a day is a plausible position in a recording.
const MAX_PLAUSIBLE_OFFSET_SECONDS = 24 * 60 * 60;
const SPEAKER_NUMBER = "__N__";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function splitFrontmatter(text) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
  const match = FRONTMATTER.exec(normalized);
  if (!match) return null;
  return {
    fields: parseFrontmatter(normalized) || {},
    block: match[1],
    body: normalized.slice(match[0].length),
  };
}

// Items of a top-level YAML list (`key:` followed by `  - item` lines).
function frontmatterList(block, key) {
  const items = [];
  let inList = false;
  for (const line of block.split("\n")) {
    if (inList) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item) {
        items.push(unquoteYaml(item[1]));
        continue;
      }
      inList = false;
    }
    if (line === `${key}:`) inList = true;
  }
  return items;
}

// SQLite CURRENT_TIMESTAMP form (UTC, no zone): how notes store their times.
function toSqliteUtc(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function validDate(date) {
  return Number.isNaN(date.getTime()) ? null : date;
}

// `openwhispr_updated` is exact (UTC); files exported before it existed only
// have Obsidian's local-time `updated`, read in this computer's time zone.
function parseFileTime(utcValue, localValue) {
  if (utcValue) {
    const date = validDate(new Date(utcValue));
    if (date) return date;
  }
  if (localValue && LOCAL_DATE_TIME.test(localValue)) return validDate(new Date(localValue));
  return null;
}

function fileUpdatedAt(fields) {
  return parseFileTime(fields?.openwhispr_updated, fields?.updated || fields?.created);
}

function parseDuration(value) {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return seconds > 0 ? seconds : null;
}

// The labels the transcript file can carry for unnamed speakers, in English
// and in the app's language. `translate(key, options)` is i18next's `t`.
function buildLabels(translate = null) {
  const labels = {
    you: ["You"],
    others: ["Others"],
    unknown: ["Unknown Speaker"],
    speakerPatterns: [/^Speaker (\d+)$/],
    notesHeadings: ["Notes"],
  };
  if (typeof translate !== "function") return labels;
  const add = (list, key) => {
    const value = translate(key);
    if (typeof value === "string" && value && value !== key && !list.includes(value)) {
      list.push(value);
    }
  };
  add(labels.you, "transcript.speaker.you");
  add(labels.others, "transcript.speaker.others");
  add(labels.unknown, "notes.speaker.unknown");
  add(labels.notesHeadings, "settings.noteFiles.export.notesHeading");
  const numbered = translate("notes.speaker.label", { n: SPEAKER_NUMBER });
  if (typeof numbered === "string" && numbered.includes(SPEAKER_NUMBER)) {
    const pattern = escapeRegExp(numbered).replace(SPEAKER_NUMBER, "(\\d+)");
    if (pattern !== "Speaker (\\d+)") labels.speakerPatterns.push(new RegExp(`^${pattern}$`));
  }
  return labels;
}

// Mirrors transcriptFormatter.resolveSpeaker in reverse. A name the user gave
// a speaker comes back locked as user-provided, as the Granola import does.
function speakerFields(label, labels) {
  if (labels.you.includes(label)) return { source: "mic", speaker: "you" };
  if (labels.others.includes(label)) return { source: "system" };
  if (labels.unknown.includes(label)) return {};
  for (const pattern of labels.speakerPatterns) {
    const match = pattern.exec(label);
    const n = match ? Number(match[1]) : 0;
    if (n >= 1) return { source: "system", speaker: `speaker_${n - 1}` };
  }
  return { source: "system", speakerName: label, speakerLocked: true, speakerLockSource: "user" };
}

function parseTranscriptBody(body, labels) {
  const turns = [];
  let current = null;
  for (const line of body.split("\n")) {
    const header = TURN_HEADER.exec(line);
    if (header) {
      const seconds = Number(header[2]) * 3600 + Number(header[3]) * 60 + Number(header[4]);
      current = { label: header[1], seconds, lines: [] };
      turns.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  const segments = [];
  let lastTimestamp = 0;
  for (const turn of turns) {
    const text = turn.lines.join("\n").trim();
    if (!text) continue;
    const timestamp = turn.seconds <= MAX_PLAUSIBLE_OFFSET_SECONDS ? turn.seconds : lastTimestamp;
    lastTimestamp = timestamp;
    segments.push({ text, timestamp, ...speakerFields(turn.label, labels) });
  }
  return segments;
}

function stripHeadingLine(text) {
  return text.replace(/^## [^\n]*\n*/, "");
}

// Undoes buildNoteMarkdown's body: the AI summary, then the raw notes behind
// NOTES_MARKER. Files from before the marker existed only end in a "Source:"
// link when they have a summary, with the raw notes under a "## Notes" heading.
function parseNoteBody(body, fields, labels) {
  let text = body.trim();
  if (fields.transcript !== undefined) text = text.replace(RELATED_LINE, "");

  if (fields.openwhispr_updated !== undefined) {
    if (fields.ai_summary !== "true") return { content: text, enhancedContent: null };
    text = text.replace(SOURCE_LINE, "").trim();
    const markerAt = text.lastIndexOf(`\n${NOTES_MARKER}\n`);
    if (markerAt === -1) return { content: "", enhancedContent: text || null };
    return {
      enhancedContent: text.slice(0, markerAt).trim() || null,
      content: stripHeadingLine(text.slice(markerAt + NOTES_MARKER.length + 2)).trim(),
    };
  }

  if (!SOURCE_LINE.test(text)) return { content: text, enhancedContent: null };
  text = text.replace(SOURCE_LINE, "").trim();
  let splitAt = -1;
  let headingLength = 0;
  for (const heading of labels.notesHeadings) {
    const needle = `\n## ${heading}\n`;
    const at = text.lastIndexOf(needle);
    if (at > splitAt) {
      splitAt = at;
      headingLength = needle.length;
    }
  }
  if (splitAt === -1) return { content: "", enhancedContent: text || null };
  return {
    enhancedContent: text.slice(0, splitAt).trim() || null,
    content: text.slice(splitAt + headingLength).trim(),
  };
}

/**
 * Parses an exported note file (and its transcript file, when it has one)
 * into note fields, or null when it isn't a note OpenWhispr exported.
 * Participants exclude speaker names, which the transcript already carries.
 */
function parseExportedNote(noteText, transcriptText, labels = buildLabels()) {
  const note = splitFrontmatter(noteText);
  const fields = note?.fields;
  const clientNoteId = fields?.openwhispr_uid;
  if (!clientNoteId || fields.summary !== undefined) return null;
  const updated = fileUpdatedAt(fields);
  if (!updated) return null;
  const created = parseFileTime(null, fields.created) || updated;

  let segments = [];
  const transcript = transcriptText == null ? null : splitFrontmatter(transcriptText);
  if (transcript && transcript.fields.openwhispr_uid === clientNoteId) {
    segments = parseTranscriptBody(transcript.body, labels);
  }

  const speakerNames = new Set(segments.map((seg) => seg.speakerName).filter(Boolean));
  const participants = frontmatterList(note.block, "participants")
    .filter((name) => name && !speakerNames.has(name))
    .map((displayName) => ({ displayName }));

  const { content, enhancedContent } = parseNoteBody(note.body, fields, labels);
  return {
    clientNoteId,
    title: fields.title || "Untitled",
    noteType:
      fields.type && fields.type !== "note" && NOTE_TYPE.test(fields.type)
        ? fields.type
        : "personal",
    folderName: fields.folder || "Personal",
    createdAt: toSqliteUtc(created),
    updatedAt: toSqliteUtc(updated),
    content,
    enhancedContent,
    transcript: segments.length > 0 ? JSON.stringify(segments) : null,
    audioDurationSeconds: parseDuration(fields.duration),
    participants: participants.length > 0 ? JSON.stringify(participants) : null,
  };
}

// The note columns a parsed file sets (folderName is resolved by the database).
const IMPORTED_COLUMNS = [
  ["title", "title"],
  ["noteType", "note_type"],
  ["folderName", "folderName"],
  ["content", "content"],
  ["enhancedContent", "enhanced_content"],
  ["transcript", "transcript"],
  ["audioDurationSeconds", "audio_duration_seconds"],
];

function noteColumns(parsed) {
  const columns = { participants: parsed.participants };
  for (const [key, column] of IMPORTED_COLUMNS) columns[column] = parsed[key];
  return columns;
}

// Columns where `incoming` differs from `current`, both parsed the same way
// so a field the export renders identically never counts as a change. An
// unknown duration keeps the stored one; participants are only set on import.
function changedColumns(current, incoming) {
  const columns = {};
  for (const [key, column] of IMPORTED_COLUMNS) {
    if (key === "audioDurationSeconds" && incoming[key] == null) continue;
    if (incoming[key] !== current[key]) columns[column] = incoming[key];
  }
  return columns;
}

module.exports = {
  buildLabels,
  changedColumns,
  fileUpdatedAt,
  noteColumns,
  parseDuration,
  parseExportedNote,
  parseTranscriptBody,
  toSqliteUtc,
};
