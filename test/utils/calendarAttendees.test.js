const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/calendarAttendees.ts");

const event = (overrides) => ({
  id: "evt",
  attendees: null,
  attendees_count: 0,
  ...overrides,
});

test("parseAttendees returns an empty list for malformed JSON", async () => {
  const { parseAttendees } = await load();
  assert.deepEqual(parseAttendees(event({ attendees: "nope" })), []);
  assert.deepEqual(parseAttendees(event({ attendees: '{"a":1}' })), []);
});
