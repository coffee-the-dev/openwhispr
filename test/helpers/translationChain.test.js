const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/translationChain.js");

// Builds an opts object with sane no-op defaults so each test only overrides what it cares about.
function makeOpts(overrides = {}) {
  return {
    text: "raw",
    cleanupReachable: true,
    shouldTranslate: true,
    runCleanup: async () => null,
    runTranslate: async () => null,
    onCleanupError: () => {},
    onEmptyTranslate: () => {},
    onUnchangedTranslate: () => {},
    ...overrides,
  };
}

test("cleanup ok then translate ok: both applied in order", async () => {
  const { executeTranslationChain } = await load();
  const calls = [];

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async (currentText) => {
        calls.push(["cleanup", currentText]);
        return "cleaned";
      },
      runTranslate: async (currentText) => {
        calls.push(["translate", currentText]);
        return "translated";
      },
    })
  );

  assert.equal(result.text, "translated");
  assert.deepEqual(calls, [
    ["cleanup", "raw"],
    ["translate", "cleaned"],
  ]);
});

test("cleanup unreachable: translate runs on the raw text", async () => {
  const { executeTranslationChain } = await load();
  let cleanupCalled = false;

  const result = await executeTranslationChain(
    makeOpts({
      cleanupReachable: false,
      runCleanup: async () => {
        cleanupCalled = true;
        return "cleaned";
      },
      runTranslate: async (currentText) => `translated(${currentText})`,
    })
  );

  assert.equal(cleanupCalled, false);
  assert.equal(result.text, "translated(raw)");
});

test("cleanup throws: onCleanupError fires, translate runs on original text", async () => {
  const { executeTranslationChain } = await load();
  const errors = [];

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async () => {
        throw new Error("cleanup boom");
      },
      onCleanupError: (err) => errors.push(err.message),
      runTranslate: async (currentText) => `translated(${currentText})`,
    })
  );

  assert.deepEqual(errors, ["cleanup boom"]);
  assert.equal(result.text, "translated(raw)");
});

test("cleanup returns whitespace-only: text unchanged, translate still runs", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async () => "   ",
      runTranslate: async (currentText) => `translated(${currentText})`,
    })
  );

  assert.equal(result.text, "translated(raw)");
});

test("translate returns whitespace-only: onEmptyTranslate fires, cleaned text kept", async () => {
  const { executeTranslationChain } = await load();
  let emptyCalled = false;

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async () => "cleaned",
      runTranslate: async () => "\u00a0",
      onEmptyTranslate: () => {
        emptyCalled = true;
      },
    })
  );

  assert.equal(emptyCalled, true);
  assert.equal(result.text, "cleaned");
});

test("shouldTranslate false: whitespace-only cleanup keeps the original text", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      text: "hello world",
      shouldTranslate: false,
      runCleanup: async () => "   ",
    })
  );

  assert.equal(result.text, "hello world");
});

test("cleanup returns empty: text unchanged, translate still runs", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async () => "",
      runTranslate: async (currentText) => `translated(${currentText})`,
    })
  );

  assert.equal(result.text, "translated(raw)");
});

test("translate returns empty: onEmptyTranslate fires, cleaned text kept", async () => {
  const { executeTranslationChain } = await load();
  let emptyCalled = false;

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async () => "cleaned",
      runTranslate: async () => "",
      onEmptyTranslate: () => {
        emptyCalled = true;
      },
    })
  );

  assert.equal(emptyCalled, true);
  assert.equal(result.text, "cleaned");
});

test("translate echoes its input: onUnchangedTranslate fires, source text kept", async () => {
  const { executeTranslationChain } = await load();
  let unchangedCalled = false;

  const result = await executeTranslationChain(
    makeOpts({
      runCleanup: async () => "cleaned source",
      runTranslate: async () => "  cleaned   source  ",
      onUnchangedTranslate: () => {
        unchangedCalled = true;
      },
    })
  );

  assert.equal(unchangedCalled, true);
  assert.equal(result.text, "cleaned source");
  assert.equal(result.translated, false);
});

test("shouldTranslate false: translate never called, cleaned text returned", async () => {
  const { executeTranslationChain } = await load();
  let translateCalled = false;

  const result = await executeTranslationChain(
    makeOpts({
      shouldTranslate: false,
      runCleanup: async () => "cleaned",
      runTranslate: async () => {
        translateCalled = true;
        return "translated";
      },
    })
  );

  assert.equal(translateCalled, false);
  assert.equal(result.text, "cleaned");
});

test("translate throws: error propagates, translate saw the cleaned text", async () => {
  const { executeTranslationChain } = await load();
  let sawText = null;

  await assert.rejects(
    () =>
      executeTranslationChain(
        makeOpts({
          runCleanup: async () => "cleaned",
          runTranslate: async (currentText) => {
            sawText = currentText;
            throw new Error("translate boom");
          },
        })
      ),
    /translate boom/
  );

  // The cleanup mutation reached the translate step before it threw.
  assert.equal(sawText, "cleaned");
});

test("shouldRunTranslateStep matrix", async () => {
  const { shouldRunTranslateStep } = await load();

  assert.equal(shouldRunTranslateStep("auto", "it"), true);
  assert.equal(shouldRunTranslateStep("en", "it"), true);
  assert.equal(shouldRunTranslateStep("it", "it"), false);
  // Empty/undefined source is treated as auto → always translate.
  assert.equal(shouldRunTranslateStep("", "it"), true);
  assert.equal(shouldRunTranslateStep("", "en"), true);
  assert.equal(shouldRunTranslateStep(undefined, "it"), true);
});

// `translated` tells the caller whether the output is really in the target language.
// audioManager keys Chinese script conversion off it: scripting a failed translation's
// source-language fallback as the target corrupts it (ja 会議の資料 → 会议の数据).
test("translated: true only when the translate step produced changed text", async () => {
  const { executeTranslationChain } = await load();

  const ok = await executeTranslationChain(makeOpts({ runTranslate: async () => "translated" }));
  assert.equal(ok.translated, true);
  assert.equal(ok.text, "translated");
});

test("translated: false when the translate step returns empty", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({ runCleanup: async () => "cleaned", runTranslate: async () => "" })
  );
  assert.equal(result.translated, false);
  assert.equal(result.text, "cleaned");
});

test("translated: false when the translate step echoes the source", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({ runCleanup: async () => "会議の資料", runTranslate: async (text) => text })
  );
  assert.equal(result.translated, false);
  assert.equal(result.text, "会議の資料");
});

test("translated: false when the translate step is skipped", async () => {
  const { executeTranslationChain } = await load();

  const result = await executeTranslationChain(
    makeOpts({ shouldTranslate: false, runTranslate: async () => "translated" })
  );
  assert.equal(result.translated, false);
  assert.equal(result.text, "raw");
});

// Guard shared with the agent/cleanup call sites (audioManager, ControlPanel history
// retry): whitespace-only reasoning output must never replace existing text (#1616).
test("hasTextContent: true only for strings with non-whitespace content", async () => {
  const { hasTextContent } = await load();

  assert.equal(hasTextContent("cleaned text"), true);
  assert.equal(hasTextContent("  padded  "), true);
  assert.equal(hasTextContent(""), false);
  assert.equal(hasTextContent("   \n\t  "), false);
  assert.equal(hasTextContent(null), false);
  assert.equal(hasTextContent(undefined), false);
});
