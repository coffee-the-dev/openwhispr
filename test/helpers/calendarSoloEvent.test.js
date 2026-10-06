const test = require("node:test");
const assert = require("node:assert/strict");

const { isSoloEvent } = require("../../src/helpers/calendarSoloEvent.js");

const attendees = (...list) => JSON.stringify(list);
const me = { email: "me@example.com", self: true };
const them = { email: "them@example.com", self: false };

test("an event without invite data is not solo", () => {
  assert.equal(isSoloEvent({ attendees: null, attendees_count: 0 }), false);
  assert.equal(isSoloEvent({ attendees: "[]", attendees_count: 0 }), false);
});

test("an event that invites only the user is solo", () => {
  assert.equal(isSoloEvent({ attendees: attendees(me), attendees_count: 1 }), true);
});

test("an event with someone else invited is not solo", () => {
  assert.equal(isSoloEvent({ attendees: attendees(me, them), attendees_count: 2 }), false);
  assert.equal(isSoloEvent({ attendees: attendees(them), attendees_count: 1 }), false);
});

test("malformed invite data is not solo", () => {
  assert.equal(isSoloEvent({ attendees: "{not json", attendees_count: 3 }), false);
  assert.equal(isSoloEvent({ attendees: '{"a":1}', attendees_count: 1 }), false);
});
