const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeStoredSpeakerCount } = require("../../src/helpers/speakerCount");

test("keeps a usable stored count, however large", () => {
  assert.equal(normalizeStoredSpeakerCount(1), 1);
  assert.equal(normalizeStoredSpeakerCount(3), 3);
  // A count the user chose: a 40-person meeting stays 40.
  assert.equal(normalizeStoredSpeakerCount(40), 40);
});

test("rejects values the cloud can persist but the app cannot use", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, null, undefined, "", {}]) {
    assert.equal(
      normalizeStoredSpeakerCount(value),
      null,
      `expected ${JSON.stringify(value)} to normalize to null`
    );
  }
});
