const test = require("node:test");
const assert = require("node:assert/strict");

// Exhaustive runtime × model-family snapshot of every tunable request param
// the chat-completions shaping layer produces. Each row asserts the FULL param
// set (presence and absence), so any change to a dialect, family constraint,
// or registry capability flag shows up here as a reviewable one-line diff.
// Rationale: #1611 shipped green because no test looked at the whole body a
// given runtime×model pair actually gets.

const load = () => import("../../src/services/ai/chatRequestBody.ts");

const MAX_TOKENS = 1000;
const CLEANUP = {};
const CLEANUP_NO_THINK = { disableThinking: true };
const AGENT = { systemPrompt: "You are an agent." };
const AGENT_NO_THINK = { systemPrompt: "You are an agent.", disableThinking: true };
const SELECTION_EDIT = { systemPrompt: "Edit the selection.", requireCompleteOutput: true };

// [description, dialect, model, config, expected params]
const MATRIX = [
  // --- Self-hosted ---
  [
    "lan cleanup keeps the classic shape",
    "lan",
    "qwen3.8-flash-next",
    CLEANUP,
    { max_tokens: MAX_TOKENS, temperature: 0 },
  ],
  [
    "lan agent requests sample at 0.3",
    "lan",
    "qwen3.8-flash-next",
    AGENT,
    { max_tokens: MAX_TOKENS, temperature: 0.3 },
  ],
  [
    "lan disables Ollama thinking via the nested reasoning object (#1021)",
    "lan",
    "qwen3.5:9b",
    CLEANUP_NO_THINK,
    {
      max_tokens: MAX_TOKENS,
      temperature: 0,
      reasoning: { effort: "none" },
      chat_template_kwargs: { enable_thinking: false },
    },
  ],
  [
    "lan gpt-oss cleanup: family low floor in both the pin and the reasoning object, no contradictory none",
    "lan",
    "gpt-oss-20b-mxfp4",
    CLEANUP_NO_THINK,
    {
      max_tokens: MAX_TOKENS,
      temperature: 0,
      reasoning_effort: "low",
      reasoning: { effort: "low" },
      chat_template_kwargs: { enable_thinking: false },
    },
  ],
  [
    "lan gpt-oss suppression sends the family floor, never the off value the family lacks",
    "lan",
    "gpt-oss-20b-mxfp4",
    AGENT_NO_THINK,
    {
      max_tokens: MAX_TOKENS,
      temperature: 0.3,
      reasoning: { effort: "low" },
      chat_template_kwargs: { enable_thinking: false },
    },
  ],
  [
    "lan selection edits on gpt-oss pin low effort",
    "lan",
    "gpt-oss-120b",
    SELECTION_EDIT,
    { max_tokens: MAX_TOKENS, temperature: 0.3, reasoning_effort: "low" },
  ],

  // --- Local llama.cpp ---
  [
    "local llama.cpp gets think false plus chat_template_kwargs (#783)",
    "local",
    "qwen3.5-4b-gguf",
    CLEANUP_NO_THINK,
    {
      max_tokens: MAX_TOKENS,
      temperature: 0,
      think: false,
      chat_template_kwargs: { enable_thinking: false },
    },
  ],
  [
    "local thinking left on sends no suppression",
    "local",
    "qwen3.5-4b-gguf",
    AGENT,
    { max_tokens: MAX_TOKENS, temperature: 0.3 },
  ],
];

for (const [name, dialect, model, config, expectedParams] of MATRIX) {
  test(`matrix: ${name}`, async () => {
    const { applyChatCompletionsParams } = await load();
    const body = { model, messages: [] };
    applyChatCompletionsParams(body, { model, dialect, config, maxTokens: MAX_TOKENS });

    const { model: _m, messages: _msgs, ...params } = body;
    assert.deepEqual(params, expectedParams);
  });
}

test("matrix: explicit temperature and maxTokens overrides always win", async () => {
  const { applyChatCompletionsParams } = await load();
  const body = { model: "qwen3.8-flash-next", messages: [] };
  applyChatCompletionsParams(body, {
    model: "qwen3.8-flash-next",
    dialect: "lan",
    config: { temperature: 0.7, maxTokens: 42 },
    maxTokens: 42,
  });
  assert.equal(body.temperature, 0.7);
  assert.equal(body.max_tokens, 42);
});
