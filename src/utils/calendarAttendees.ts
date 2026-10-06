import type { CalendarAttendee, CalendarEvent } from "../types/calendar";

export function parseAttendees(event: CalendarEvent): CalendarAttendee[] {
  if (!event.attendees) return [];
  try {
    const parsed = JSON.parse(event.attendees);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
