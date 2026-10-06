// Calendar.app only carries invitees for invitation-backed events; events in
// most iCloud and local calendars have none, even when they are meetings. So
// an event counts as a solo time block only when its invite list names the
// user alone — an event without invite data is treated as a possible meeting.
export function isSoloEvent(event) {
  if (!event?.attendees) return false;
  try {
    const attendees = JSON.parse(event.attendees);
    return (
      Array.isArray(attendees) &&
      attendees.length > 0 &&
      attendees.every((attendee) => attendee?.self === true)
    );
  } catch {
    return false;
  }
}
