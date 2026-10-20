import type { CalendarAttendee } from "../types/calendar";

function isAttendee(value: unknown): value is CalendarAttendee {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { email?: unknown }).email === "string"
  );
}

/** A note's `participants` column (JSON), or [] when it is missing or malformed. */
export function parseNoteParticipants(raw: string | null | undefined): CalendarAttendee[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAttendee) : [];
  } catch {
    return [];
  }
}

const ATTENDEES_FENCE = "meeting_attendees";

/**
 * Other context the model reads next to the attendee block: the note's
 * title (a calendar invite's, which anyone can write), its text and search
 * results. The fence's tag name is taken out of it, so none of it can open
 * or close a second attendee list, whatever brackets it uses.
 */
export function withoutAttendeesFence(text: string): string {
  return text.replace(new RegExp(ATTENDEES_FENCE, "gi"), "meeting attendees");
}
