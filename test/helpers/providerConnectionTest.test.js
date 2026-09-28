const assert = require("node:assert/strict");
const test = require("node:test");
const providerTest = require("../../src/helpers/providerConnectionTest.js");

const { resolveProviderRequest, testProviderConnection } = providerTest;

test("builds server tests without placing credentials in the URL", () => {
  const request = resolveProviderRequest({ baseUrl: "https://vllm.lan/v1", apiKey: "secret" });
  assert.equal(request.endpoint, "https://vllm.lan/v1/models");
  assert.equal(request.endpoint.includes("secret"), false);
  assert.equal(request.headers.Authorization, "Bearer secret");
});

test("normalizes custom compatible endpoints", () => {
  assert.equal(
    resolveProviderRequest({ baseUrl: "localhost:11434/v1", apiKey: "" }).endpoint,
    "https://localhost:11434/v1/models"
  );
});

test("probes the /v1 sibling for bare custom origins", () => {
  assert.deepEqual(
    resolveProviderRequest({ baseUrl: "http://localhost:1234", apiKey: "" }).endpoints,
    ["http://localhost:1234/models", "http://localhost:1234/v1/models"]
  );
  // LM Studio's native REST base maps to its OpenAI-compatible /v1 sibling.
  assert.deepEqual(resolveProviderRequest({ baseUrl: "http://localhost:1234/api/v0" }).endpoints, [
    "http://localhost:1234/api/v0/models",
    "http://localhost:1234/v1/models",
  ]);
});

// The runtime (isSecureHttpEndpoint in src/utils/urlUtils.ts) refuses plain
// HTTP on public hosts, so the test must refuse the same URLs — a passing test
// would otherwise commit a config every real request rejects.
test("rejects public HTTP endpoints but allows private hosts", async () => {
  assert.deepEqual(await testProviderConnection({ baseUrl: "http://myserver.example.com/v1" }), {
    success: false,
    errorCode: "httpsRequired",
    error: "Public endpoints must use HTTPS. HTTP is only allowed on private addresses.",
  });

  for (const baseUrl of [
    "http://localhost:1234",
    "http://192.168.1.10:8080/v1",
    "http://100.101.102.103/v1",
    "http://ollama.ts.net/v1",
  ]) {
    assert.equal(resolveProviderRequest({ baseUrl }).endpoints.length > 0, true);
  }

  // A public DNS name that merely starts with a private prefix is still public.
  assert.equal(
    (await testProviderConnection({ baseUrl: "http://10.example.com/v1" })).errorCode,
    "httpsRequired"
  );
});

test("rejects invalid custom endpoints with error codes", async () => {
  assert.deepEqual(await testProviderConnection({ baseUrl: "" }), {
    success: false,
    errorCode: "endpointRequired",
    error: "Enter an endpoint URL before testing.",
  });

  assert.deepEqual(await testProviderConnection({ baseUrl: "ftp://x" }), {
    success: false,
    errorCode: "invalidUrl",
    error: "The endpoint must use HTTP or HTTPS.",
  });
});

test("maps authentication and transport failures to safe messages", async () => {
  assert.deepEqual(
    await testProviderConnection({ baseUrl: "https://vllm.lan/v1", apiKey: "bad" }, async () => ({
      ok: false,
      status: 401,
    })),
    {
      success: false,
      errorCode: "credentialsRejected",
      error: "The server rejected these credentials.",
      status: 401,
    }
  );

  assert.deepEqual(
    await testProviderConnection({ baseUrl: "https://vllm.lan/v1", apiKey: "bad" }, async () => {
      throw new Error("secret upstream detail");
    }),
    { success: false, errorCode: "network", error: "The server could not be reached." }
  );

  assert.deepEqual(
    await testProviderConnection({ baseUrl: "https://vllm.lan/v1", apiKey: "k" }, async () => ({
      ok: false,
      status: 500,
    })),
    {
      success: false,
      errorCode: "providerStatus",
      error: "The server returned status 500.",
      status: 500,
    }
  );
});

test("succeeds when only the /v1 candidate responds", async () => {
  const attempted = [];
  const result = await testProviderConnection({ baseUrl: "http://localhost:1234" }, async (url) => {
    attempted.push(url);
    return url.includes("/v1/models") ? { ok: true, status: 200 } : { ok: false, status: 404 };
  });
  assert.deepEqual(result, { success: true });
  assert.deepEqual(attempted, ["http://localhost:1234/models", "http://localhost:1234/v1/models"]);
});

test("rejects a successful model list that omits the selected model", async () => {
  assert.deepEqual(
    await testProviderConnection(
      { baseUrl: "http://localhost:1234/v1", model: "typo-model" },
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "real-model" }] }),
      })
    ),
    {
      success: false,
      errorCode: "modelNotFound",
      error: "The selected model is not available from this server.",
    }
  );
});

test("accepts selected models from OpenAI and Gemini model-list shapes", async () => {
  for (const payload of [
    { data: [{ id: "selected-model" }] },
    { models: [{ name: "models/selected-model" }] },
  ]) {
    assert.deepEqual(
      await testProviderConnection(
        { baseUrl: "http://localhost:1234/v1", model: "selected-model" },
        async () => ({ ok: true, status: 200, json: async () => payload })
      ),
      { success: true }
    );
  }
});

test("continues to a compatible candidate when an earlier model list omits the selection", async () => {
  const attempted = [];
  const result = await testProviderConnection(
    { baseUrl: "http://localhost:1234", model: "selected-model" },
    async (url) => {
      attempted.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: url.includes("/v1/models") ? "selected-model" : "native-model" }],
        }),
      };
    }
  );

  assert.deepEqual(result, { success: true });
  assert.deepEqual(attempted, ["http://localhost:1234/models", "http://localhost:1234/v1/models"]);
});

test("reports endpointNotFound only after every candidate 404s", async () => {
  assert.deepEqual(
    await testProviderConnection({ baseUrl: "http://localhost:1234" }, async () => ({
      ok: false,
      status: 404,
    })),
    {
      success: false,
      errorCode: "endpointNotFound",
      error: "The endpoint does not expose an OpenAI-compatible model list.",
      status: 404,
    }
  );

  // A credentials failure on any candidate outranks a 404 on another.
  assert.deepEqual(
    await testProviderConnection(
      { baseUrl: "http://localhost:1234", apiKey: "bad" },
      async (url) => ({ ok: false, status: url.includes("/v1/models") ? 401 : 404 })
    ),
    {
      success: false,
      errorCode: "credentialsRejected",
      error: "The server rejected these credentials.",
      status: 401,
    }
  );
});

test("lists model ids from the first candidate that has any", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    if (url === "https://vllm.ash.example/models") return new Response("", { status: 404 });
    return Response.json({ data: [{ id: "whisper-1" }, { id: "Qwen3-ASR-1.7B" }] });
  };
  const result = await providerTest.listRemoteModels(
    { baseUrl: "https://vllm.ash.example", apiKey: "k" },
    fetchImpl
  );
  assert.deepEqual(result, { success: true, models: ["whisper-1", "Qwen3-ASR-1.7B"] });
  assert.deepEqual(
    seen.map((s) => s.url),
    ["https://vllm.ash.example/models", "https://vllm.ash.example/v1/models"]
  );
  assert.ok(seen.every((s) => s.auth === "Bearer k"));
});

test("model listing reports rejected credentials and empty lists", async () => {
  const rejected = await providerTest.listRemoteModels(
    { baseUrl: "https://vllm.ash.example/v1" },
    async () => new Response("", { status: 401 })
  );
  assert.equal(rejected.success, false);
  assert.equal(rejected.errorCode, "credentialsRejected");
  assert.deepEqual(rejected.models, []);

  const empty = await providerTest.listRemoteModels(
    { baseUrl: "https://vllm.ash.example/v1" },
    async () => Response.json({ data: [] })
  );
  assert.equal(empty.success, false);
  assert.deepEqual(empty.models, []);
});
