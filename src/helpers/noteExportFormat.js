// Pure naming and formatting for the note-files mirror (markdownMirror.js):
// Obsidian-friendly file names, frontmatter and bodies. No filesystem access.
const {
  formatMdTurns,
  namedSpeakers,
  parseNoteDate,
  transcriptDurationSeconds,
} = require("./transcriptFormatter");

const DEFAULT_BASE_TAG = "openwhispr";
const TRANSCRIPT_SUFFIX = " (transcript)";
const MAX_TITLE_LENGTH = 80;
// Marks where a note file's raw notes start after its AI summary, so the
// importer (noteImportFormat.js) can split them apart again. An HTML comment:
// hidden in Obsidian's reading view.
const NOTES_MARKER = "<!-- openwhispr:notes -->";

const pad = (n) => String(n).padStart(2, "0");

function toDate(value) {
  const date = value instanceof Date ? value : parseNoteDate(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLocalDate(value) {
  const date = toDate(value);
  if (!date) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Obsidian's date & time property format: local time, no zone.
function formatLocalDateTime(value) {
  const date = toDate(value);
  if (!date) return null;
  return `${formatLocalDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// The exact last-change time (UTC) another computer's import compares
// against; `updated` is local time without a zone, which isn't comparable
// across time zones.
function formatUtcDateTime(value) {
  const date = toDate(value);
  return date ? date.toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

function formatLocalTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Strips what macOS, Windows or Obsidian reject in a file name ([]#^| break
// wikilinks; /\: and the Windows set break paths) and keeps it one line.
function sanitizeFileTitle(title) {
  const cleaned = String(title || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[[\]#^|/\\:*?"<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const chars = Array.from(cleaned);
  const truncated =
    chars.length > MAX_TITLE_LENGTH ? chars.slice(0, MAX_TITLE_LENGTH).join("") : cleaned;
  return truncated.replace(/[\s.]+$/, "") || "Untitled";
}

function buildFileStem(note, disambiguator = null) {
  const date = formatLocalDate(note.created_at) || formatLocalDate(new Date());
  const stem = `${date} ${sanitizeFileTitle(note.title)}`;
  return disambiguator ? `${stem} (${disambiguator})` : stem;
}

function noteFileName(stem) {
  return `${stem}.md`;
}

function transcriptFileName(stem) {
  return `${stem}${TRANSCRIPT_SUFFIX}.md`;
}

// Obsidian tags allow letters, digits, _, - and / and must not be all digits.
function sanitizeTag(tag) {
  const cleaned = String(tag || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_\-/]/gu, "")
    .replace(/^\/+|\/+$/g, "");
  if (!cleaned || /^\d+$/.test(cleaned)) return null;
  return cleaned;
}

function mapNoteType(noteType) {
  if (!noteType || noteType === "personal") return "note";
  return noteType;
}

function yamlScalar(value) {
  if (typeof value === "number") return String(value);
  const str = String(value ?? "");
  if (!str) return '""';
  if (
    /[\n\r\t]/.test(str) ||
    /: |:$| #/.test(str) ||
    /^[-?:,[\]{}#&*!|>'"%@`\s]|\s$/.test(str) ||
    /^(true|false|yes|no|null|on|off|~)$/i.test(str) ||
    /^[+-]?(\d|\.\d)/.test(str)
  ) {
    return `"${str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")}"`;
  }
  return str;
}

// Dates and datetimes stay unquoted so Obsidian types them as date properties.
function buildFrontmatter(entries) {
  const lines = ["---"];
  for (const [key, value, { raw = false } = {}] of entries) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${key}: ${raw ? value : yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function unquoteYaml(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed
      .slice(1, -1)
      .replace(/\\(["\\nrt])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" })[c] || c);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

// Top-level scalar keys of a leading frontmatter block, or null when the text
// has none. Tolerates a BOM and CRLF (a file an external editor re-saved).
function parseFrontmatter(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):(?:\s(.*))?$/.exec(line);
    if (kv) fields[kv[1]] = unquoteYaml(kv[2] || "");
  }
  return fields;
}

function parseJsonArray(json) {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseSegments(note) {
  return parseJsonArray(note.transcript).filter((seg) => seg && typeof seg === "object");
}

function resolveParticipants(note, segments, speakerMappings) {
  const names = [];
  for (const p of parseJsonArray(note.participants)) {
    if (p && p.self !== true) names.push(p.displayName || p.email);
  }
  names.push(...namedSpeakers(segments, speakerMappings || {}));
  const seen = new Set();
  const result = [];
  for (const name of names) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    result.push(trimmed);
  }
  return result;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function resolveDuration(note, segments) {
  const stored = Number(note.audio_duration_seconds);
  if (Number.isFinite(stored) && stored > 0) return formatDuration(stored);
  return segments.length ? formatDuration(transcriptDurationSeconds(note, segments)) : null;
}

function formatCalendarEvent(event) {
  if (!event) return null;
  const title = String(event.summary || "").trim() || "Untitled event";
  const start = event.start_time ? new Date(event.start_time) : null;
  if (!start || Number.isNaN(start.getTime())) return title;
  if (event.is_all_day) return `${title} (${formatLocalDate(start)})`;
  const end = event.end_time ? new Date(event.end_time) : null;
  const range =
    end && !Number.isNaN(end.getTime())
      ? `${formatLocalTime(start)}–${formatLocalTime(end)}`
      : formatLocalTime(start);
  return `${title} (${formatLocalDate(start)} ${range})`;
}

function buildTags(baseTag, type, extra) {
  const tags = [sanitizeTag(baseTag), sanitizeTag(type), extra ? sanitizeTag(extra) : null];
  return [...new Set(tags.filter(Boolean))];
}

function wikilink(stem, alias) {
  const label = alias
    ? String(alias)
        .replace(/[[\]|\n\r]+/g, " ")
        .trim()
    : "";
  return label ? `[[${stem}|${label}]]` : `[[${stem}]]`;
}

// Drops a leading "# Title" when it repeats the note title: Obsidian already
// shows the file name, so a duplicate H1 reads as the title twice.
function stripLeadingTitleHeading(body, title) {
  const text = String(body || "").replace(/^\uFEFF/, "");
  const match = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(text);
  if (!match) return text.trim();
  const normalize = (s) =>
    String(s || "")
      .trim()
      .toLowerCase();
  if (normalize(match[1]) !== normalize(title)) return text.trim();
  return text.slice(match[0].length).trim();
}

function commonFrontmatter(note, ctx, type) {
  return [
    ["openwhispr_id", note.id],
    ["openwhispr_uid", note.client_note_id || null],
    ["openwhispr_updated", formatUtcDateTime(note.updated_at || note.created_at), { raw: true }],
    ["title", note.title || "Untitled"],
    ["type", type],
    ["date", formatLocalDate(note.created_at), { raw: true }],
    ["created", formatLocalDateTime(note.created_at), { raw: true }],
    ["updated", formatLocalDateTime(note.updated_at || note.created_at), { raw: true }],
    ["folder", ctx.folderName || "Personal"],
  ];
}

function buildNoteMarkdown(note, ctx, stem) {
  const segments = parseSegments(note);
  const hasTranscript = segments.length > 0;
  const type = mapNoteType(note.note_type);
  const transcriptStem = `${stem}${TRANSCRIPT_SUFFIX}`;
  const summary = stripLeadingTitleHeading(note.enhanced_content, note.title);
  const raw = stripLeadingTitleHeading(note.content, note.title);
  const frontmatter = buildFrontmatter([
    ...commonFrontmatter(note, ctx, type),
    ["duration", resolveDuration(note, segments)],
    ["participants", resolveParticipants(note, segments, ctx.speakerMappings)],
    ["calendar_event", formatCalendarEvent(ctx.calendarEvent)],
    ["ai_summary", summary ? "true" : null, { raw: true }],
    ["tags", buildTags(ctx.baseTag ?? DEFAULT_BASE_TAG, type)],
    ["transcript", hasTranscript ? wikilink(transcriptStem) : null],
  ]);

  const transcriptLabel = ctx.transcriptLabel || "Transcript";
  const notesHeading = ctx.notesHeading || "Notes";

  const parts = [];
  if (hasTranscript) parts.push(`Related: ${wikilink(transcriptStem, transcriptLabel)}`);
  if (summary) {
    parts.push(summary);
    if (raw && raw !== summary) parts.push(`${NOTES_MARKER}\n## ${notesHeading}\n\n${raw}`);
    if (hasTranscript) parts.push(`Source: ${wikilink(transcriptStem, transcriptLabel)}`);
  } else if (raw) {
    parts.push(raw);
  }
  return `${frontmatter}\n\n${parts.join("\n\n")}\n`;
}

function buildTranscriptMarkdown(note, ctx, stem) {
  const segments = parseSegments(note);
  const type = mapNoteType(note.note_type);
  const frontmatter = buildFrontmatter([
    ...commonFrontmatter(note, ctx, type),
    ["duration", resolveDuration(note, segments)],
    ["participants", resolveParticipants(note, segments, ctx.speakerMappings)],
    ["calendar_event", formatCalendarEvent(ctx.calendarEvent)],
    ["tags", buildTags(ctx.baseTag ?? DEFAULT_BASE_TAG, type, "transcript")],
    ["summary", wikilink(stem)],
  ]);
  const turns = formatMdTurns(note, segments, ctx.speakerMappings || {}).trimEnd();
  return `${frontmatter}\n\nRelated: ${wikilink(stem, note.title || stem)}\n\n${turns}\n`;
}

// The mirror's pre-Obsidian naming ("<id>-<slug>.md"), kept only to recognise
// files it wrote before so they can be renamed rather than duplicated.
function legacySlug(title) {
  return (title || "Untitled")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
}

function legacyTranscriptFileName(note) {
  return `${note.id}-${legacySlug(note.title)}-transcript.md`;
}

function dictationFileStem(date) {
  return formatLocalDate(date);
}

function buildDictationHeader(date, baseTag) {
  const day = formatLocalDate(date);
  return `${buildFrontmatter([
    ["openwhispr_dictations", day, { raw: true }],
    ["date", day, { raw: true }],
    ["tags", buildTags(baseTag ?? DEFAULT_BASE_TAG, "dictation")],
  ])}\n\n`;
}

function buildDictationEntry(date, text) {
  const lines = String(text || "")
    .trim()
    .split(/\r?\n/);
  const [first, ...rest] = lines;
  const continuation = rest.map((line) => (line.trim() ? `  ${line}` : "")).join("\n");
  return `- **${formatLocalTime(toDate(date) || new Date())}** ${first}${continuation ? `\n${continuation}` : ""}\n`;
}

module.exports = {
  DEFAULT_BASE_TAG,
  NOTES_MARKER,
  TRANSCRIPT_SUFFIX,
  buildDictationEntry,
  buildDictationHeader,
  buildFileStem,
  buildFrontmatter,
  buildNoteMarkdown,
  buildTranscriptMarkdown,
  dictationFileStem,
  formatCalendarEvent,
  formatDuration,
  formatLocalDate,
  formatLocalDateTime,
  formatUtcDateTime,
  legacySlug,
  legacyTranscriptFileName,
  mapNoteType,
  noteFileName,
  parseFrontmatter,
  parseSegments,
  resolveParticipants,
  sanitizeFileTitle,
  sanitizeTag,
  stripLeadingTitleHeading,
  transcriptFileName,
  unquoteYaml,
  yamlScalar,
};
