// expected_speaker_count is a total that already includes you, so anything below
// 1 is meaningless. Cloud sync persists whatever the server sends, so invalid
// values arrive as data rather than as programmer error and must degrade to null.
// No upper bound: it is a count the user chose.
function normalizeStoredSpeakerCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 ? count : null;
}

module.exports = { normalizeStoredSpeakerCount };
