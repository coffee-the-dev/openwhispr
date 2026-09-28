const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/chatRouting.js");

test("local Chat stays on its local route", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({ provider: "qwen" });

  assert.deepEqual(route, { kind: "local", baseUrl: "", apiKey: "" });
});

test("a self-hosted Chat URL is trimmed and carries its key", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "lan",
    lanUrl: "  http://127.0.0.1:4000/v1  ",
    customApiKey: "  secret-key  ",
  });

  assert.deepEqual(route, {
    kind: "self-hosted",
    baseUrl: "http://127.0.0.1:4000/v1",
    apiKey: "secret-key",
  });
});

test("self-hosted Chat preserves an empty optional API key", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({ lanUrl: "http://127.0.0.1:11434/v1" });

  assert.equal(route.kind, "self-hosted");
  assert.equal(route.apiKey, "");
});

test("a self-hosted Chat with no URL never falls back to a local model", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({ provider: "lan", lanUrl: "   " });

  assert.equal(route.kind, "self-hosted");
  assert.equal(route.baseUrl, "");
});
