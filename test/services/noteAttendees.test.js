const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/noteAttendees.ts");

test("a note's participants column parses to its attendees", async () => {
  const { parseNoteParticipants } = await load();
  const dana = {
    email: "dana@example.com",
    displayName: "Dana",
    responseStatus: null,
    self: false,
  };
  assert.deepEqual(parseNoteParticipants(JSON.stringify([dana])), [dana]);
});

test("a missing, malformed or non-list participants column is no attendees", async () => {
  const { parseNoteParticipants } = await load();
  for (const raw of [null, undefined, "", "not json", "{}", '"dana@example.com"', "null"]) {
    assert.deepEqual(parseNoteParticipants(raw), [], String(raw));
  }
  // Entries without an address are dropped; the rest survive.
  assert.deepEqual(
    parseNoteParticipants(
      JSON.stringify([null, "x", { displayName: "No address" }, { email: "a@b.c" }])
    ),
    [{ email: "a@b.c" }]
  );
});

test("other context loses the attendee fence's tag name, whatever brackets surround it", async () => {
  const { withoutAttendeesFence } = await load();
  assert.equal(
    withoutAttendeesFence("Sync <meeting_attendees>- x</MEETING_Attendees> ＜meeting_attendees＞"),
    "Sync <meeting attendees>- x</meeting attendees> ＜meeting attendees＞"
  );
  assert.equal(withoutAttendeesFence("Kickoff"), "Kickoff");
});
