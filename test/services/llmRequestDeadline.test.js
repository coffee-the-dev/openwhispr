const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Generate AI Summary sends a whole transcript to a model that may reason for a
// minute or more before writing. Under the 30-second dictation deadline every
// such request was aborted and, counted as a network fault, retried three more
// times: four billed requests and no note (1.10.1).

const LAN_URL = "http://127.0.0.1:8080/v1";

// A fetch whose POSTs never answer on their own but honor the abort signal,
// the way a real request does while the model is still generating.
function installHangingFetch(t) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const posts = [];
  globalThis.fetch = (input, init = {}) => {
    const method = init.method || "GET";
    if (method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    posts.push(String(input));
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    });
  };
  return posts;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function runDeadlineScenario(t, startRequest) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const posts = installHangingFetch(t);

  let outcome = null;
  const request = startRequest().then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    }
  );
  await settle();
  assert.equal(posts.length, 1, "the request should be in flight");

  // The dictation deadline must not fire on a note.
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(outcome, null, "a note request must survive the 30-second dictation deadline");

  t.mock.timers.tick(600_000);
  await settle();
  // A retry would be waiting on its backoff timer here; drain it so the second
  // POST shows up in `posts` instead of leaving `request` pending.
  t.mock.timers.tick(10_000);
  await settle();

  assert.equal(posts.length, 1, "a timed-out request must not be retried");
  assert.ok(outcome?.error, "the request should end in an error once the long deadline expires");
  // Self-hosted deadlines surface classified; the raw deadline rides along as the cause.
  assert.equal(outcome.error.code, "PROVIDER_TIMEOUT");
  assert.match(outcome.error.cause?.message ?? "", /Request timed out after 600s/);
  await request;
}

async function loadReasoningService(t, cachePrefix) {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, { cachePrefix });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  return { reasoningService, vite };
}

test("dictation cleanup keeps its 30-second deadline", async (t) => {
  const { reasoningService } = await loadReasoningService(t, "openwhispr-cleanup-deadline-test-");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const posts = installHangingFetch(t);

  let outcome = null;
  const request = reasoningService
    .processText("clean this up", "qwen3.8-flash-next", null, {
      lanUrl: LAN_URL,
      inferenceScope: "dictationCleanup",
    })
    .then(
      (value) => {
        outcome = { value };
      },
      (error) => {
        outcome = { error };
      }
    );
  try {
    await settle();
    assert.equal(posts.length, 1);

    t.mock.timers.tick(30_000);
    await settle();
    await request;

    // Self-hosted deadlines surface classified; the raw deadline rides along as the cause.
    assert.equal(outcome?.error?.code, "PROVIDER_TIMEOUT");
    assert.match(outcome?.error?.cause?.message ?? "", /Request timed out after 30s/);
  } finally {
    t.mock.timers.reset();
  }
});

// The note store's overrides go through the real ReasoningService dispatch
// (provider selection, retry) to the self-hosted client, and the request still
// outlives the dictation deadline and is sent once.
test("a note request through the real ReasoningService survives the dictation deadline and is sent once", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-note-deadline-test-"
  );
  const { buildNoteFormattingOverrides } = await vite.ssrLoadModule(
    "/helpers/noteFormattingOverrides.js"
  );

  try {
    await runDeadlineScenario(t, () =>
      reasoningService.processText(
        "## Meeting Transcript\n" + "Alice: we agreed to ship on Friday.\n".repeat(200),
        "qwen3.8-flash-next",
        null,
        {
          systemPrompt: "Summarize the meeting.",
          maxTokens: 4096,
          temperature: 0.3,
          ...buildNoteFormattingOverrides({ mode: "self-hosted", remoteUrl: LAN_URL }),
        }
      )
    );
  } finally {
    // Hand real timers back before the harness tears the Vite server down.
    t.mock.timers.reset();
  }
});
