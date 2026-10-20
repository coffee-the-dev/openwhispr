const assert = require("node:assert/strict");
const http = require("node:http");
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
    {
      success: false,
      errorCode: "network",
      error: "The server could not be reached.",
      unverified: true,
    }
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
      unverified: true,
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

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  // undefined is an empty body; a string is raw text (JSON.parse throws on non-JSON).
  json: async () => {
    if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
    return typeof body === "string" ? JSON.parse(body) : body;
  },
});

function recordingFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { calls, fetchImpl };
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("a server that is slow, busy or down gives no verdict, so the failure is unverified", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const result = await testProviderConnection(
      { baseUrl: "https://vllm.lan/v1", apiKey: "k" },
      async () => ({
        ok: false,
        status,
      })
    );
    assert.equal(result.success, false, String(status));
    assert.equal(result.errorCode, "providerStatus", String(status));
    assert.equal(result.unverified, true, String(status));
  }
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  for (const [error, errorCode] of [
    [aborted, "timeout"],
    [new TypeError("fetch failed"), "network"],
  ]) {
    const result = await testProviderConnection(
      { baseUrl: "https://vllm.lan/v1", apiKey: "k" },
      async () => {
        throw error;
      }
    );
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.unverified, true, errorCode);
  }
});

test("an answer that faults the key or the setup is never unverified", async () => {
  const base = { baseUrl: "https://vllm.lan/v1", apiKey: "k" };
  const cases = [
    [base, () => ({ ok: false, status: 401 }), "credentialsRejected"],
    [base, () => ({ ok: false, status: 403 }), "credentialsRejected"],
    [base, () => ({ ok: false, status: 400 }), "providerStatus"],
    [base, () => ({ ok: false, status: 402 }), "providerStatus"],
    [
      { ...base, model: "gone" },
      () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "other" }] }) }),
      "modelNotFound",
    ],
    [{ baseUrl: "http://localhost:1234" }, () => ({ ok: false, status: 404 }), "endpointNotFound"],
  ];
  for (const [config, answer, errorCode] of cases) {
    const result = await testProviderConnection(config, async () => answer());
    assert.equal(result.errorCode, errorCode, errorCode);
    assert.equal(result.unverified, undefined, errorCode);
  }
});

test("across a server's addresses, an answer outranks no answer", async () => {
  const base = "http://localhost:1234";
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  const answer = (models, v1) => async (url) => {
    const reply = url.includes("/v1/models") ? v1 : models;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const check = (config, fetchImpl) =>
    testProviderConnection({ baseUrl: base, ...config }, fetchImpl);
  const listWithout = {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "other" }] }),
  };

  // A busy address never hides a refused key or a missing model on the other one.
  const missing = await check({ model: "m" }, answer({ ok: false, status: 503 }, listWithout));
  assert.equal(missing.errorCode, "modelNotFound");
  assert.equal(missing.unverified, undefined);
  const refused = await check({ apiKey: "bad" }, answer(aborted, { ok: false, status: 401 }));
  assert.equal(refused.errorCode, "credentialsRejected");

  // A real status wins whichever address answered it.
  for (const [first, second] of [
    [400, 503],
    [503, 400],
  ]) {
    const result = await check(
      {},
      answer({ ok: false, status: first }, { ok: false, status: second })
    );
    assert.equal(result.status, 400, `${first} then ${second}`);
    assert.equal(result.unverified, undefined, `${first} then ${second}`);
  }

  // No answer outranks an address without a model list, which the server may not use.
  const busy = await check({}, answer({ ok: false, status: 404 }, { ok: false, status: 503 }));
  assert.equal(busy.status, 503);
  assert.equal(busy.unverified, true);
  const slow = await check({}, answer({ ok: false, status: 404 }, aborted));
  assert.equal(slow.errorCode, "timeout");
  assert.equal(slow.unverified, true);
});

// A stand-in speech server with no model list. Its transcription address answers `status`,
// and every request it gets is recorded with its body.
async function speechServer(t, status) {
  const received = [];
  const base = await listen(t, (request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(request.method === "POST" ? status : 404).end("{}");
    });
  });
  return { base, received };
}

const speech = (baseUrl, extra = {}) => ({
  scope: "transcription",
  baseUrl,
  model: "whisper-large-v3",
  ...extra,
});

test("a speech server with no model list is checked at its transcription address", async (t) => {
  for (const status of [400, 422]) {
    const { base, received } = await speechServer(t, status);
    const result = await testProviderConnection(speech(base, { apiKey: "sk-local" }));
    assert.deepEqual(result, { success: true }, String(status));
    assert.deepEqual(
      received.map((entry) => `${entry.method} ${entry.url}`),
      ["GET /models", "GET /v1/models", "POST /audio/transcriptions"]
    );
    const post = received[2];
    assert.match(post.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.equal(post.headers.authorization, "Bearer sk-local");
    assert.match(post.body, /name="model"\r\n\r\nwhisper-large-v3\r\n/);
    assert.doesNotMatch(post.body, /filename=/, "no audio is sent");
  }
});

test("the transcription address is the one the app sends audio to", async (t) => {
  const { base, received } = await speechServer(t, 422);
  assert.deepEqual(await testProviderConnection(speech(`${base}/v1`)), { success: true });
  assert.deepEqual(
    received.map((entry) => `${entry.method} ${entry.url}`),
    ["GET /v1/models", "POST /v1/audio/transcriptions"]
  );
  assert.equal(received[1].headers.authorization, undefined, "no key, no header");

  // The full address with a trailing slash: the slash hides the suffix from one pass of
  // normalizeBaseUrl, and the app's second pass is what strips it.
  const typedInFull = await speechServer(t, 422);
  const fullAddress = `${typedInFull.base}/v1/audio/transcriptions/`;
  assert.deepEqual(await testProviderConnection(speech(fullAddress)), { success: true });
  assert.deepEqual(
    typedInFull.received
      .filter((entry) => entry.method === "POST")
      .map((entry) => `${entry.method} ${entry.url}`),
    ["POST /v1/audio/transcriptions"]
  );
});

test("the transcription address's answers keep their meaning", async (t) => {
  const nothingHere = "Nothing takes transcriptions at this address.";
  for (const [status, errorCode, error] of [
    [401, "credentialsRejected", "The server rejected these credentials."],
    [403, "credentialsRejected", "The server rejected these credentials."],
    [404, "transcriptionEndpointNotFound", nothingHere],
    [405, "transcriptionEndpointNotFound", nothingHere],
    [500, "providerStatus", "The server returned status 500."],
    [200, "providerStatus", "The server returned status 200."],
  ]) {
    const { base } = await speechServer(t, status);
    const result = await testProviderConnection(speech(base));
    assert.equal(result.errorCode, errorCode, String(status));
    assert.equal(result.status, status);
    assert.equal(result.error, error, String(status));
  }
  const flaky = recordingFetch((url, init) => {
    if (init.method === "POST") throw new TypeError("fetch failed");
    return jsonResponse(404);
  });
  const offline = await testProviderConnection(speech("http://127.0.0.1:9"), flaky.fetchImpl);
  assert.equal(offline.errorCode, "network");
  assert.equal(flaky.calls[2].init.method, "POST");
});

test("only a speech check with every model list missing asks that address", async (t) => {
  const { base, received } = await speechServer(t, 422);
  // A language-model server keeps today's answer.
  const reasoning = await testProviderConnection({ ...speech(base), scope: "reasoning" });
  assert.equal(reasoning.errorCode, "endpointNotFound");
  assert.equal(
    received.some((entry) => entry.method === "POST"),
    false
  );

  const keyed = recordingFetch((url) => jsonResponse(url.endsWith("/v1/models") ? 401 : 404));
  const config = speech("http://127.0.0.1:9", { apiKey: "k" });
  const rejected = await testProviderConnection(config, keyed.fetchImpl);
  assert.equal(rejected.errorCode, "credentialsRejected");
  assert.equal(keyed.calls.length, 2, "a list that answered anything but 404 already said why");

  const down = recordingFetch(() => {
    throw new TypeError("fetch failed");
  });
  const unreachable = await testProviderConnection(speech("http://127.0.0.1:9"), down.fetchImpl);
  assert.equal(unreachable.errorCode, "network");
  assert.equal(down.calls.length, 2);
});

test("a model list whose body never arrives is no verdict, not a missing model", async () => {
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  for (const [error, errorCode] of [
    [aborted, "timeout"],
    [new TypeError("terminated"), "network"],
  ]) {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw error;
      },
    });
    const result = await testProviderConnection(
      { baseUrl: "https://vllm.lan/v1", apiKey: "k", model: "qwen-test" },
      fetchImpl
    );
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.unverified, true);
  }
  const unreadable = await testProviderConnection(
    { baseUrl: "https://vllm.lan/v1", apiKey: "k", model: "qwen-test" },
    async () => jsonResponse(200, "not json")
  );
  assert.equal(unreadable.errorCode, "modelNotFound", "a list that can't be read offers nothing");
});
