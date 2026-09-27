const test = require("node:test");
const assert = require("node:assert/strict");

const { createCloudConfigRequestHandler } = require("../../src/helpers/cloudConfigRequest");

test("the config handler preserves upgrade response metadata", async () => {
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAuthHeader: async () => ({ Authorization: "Bearer token-a" }),
    proxyFetch: async (_url, options) => {
      return new Response(
        JSON.stringify({
          error: "Update required",
          code: "UPGRADE_REQUIRED",
          data: { minAppVersion: "2.0.0" },
        }),
        { status: 426 }
      );
    },
    logger: { error() {} },
    configPath: "stt-config",
  });

  assert.deepEqual(await handler({ sender: {} }), {
    success: false,
    error: "Update required",
    code: "UPGRADE_REQUIRED",
    status: 426,
    minAppVersion: "2.0.0",
    details: { minAppVersion: "2.0.0" },
  });
});

test("the config handler keeps successful and legacy auth results compatible", async () => {
  const responses = [
    new Response(JSON.stringify({ dictation: { mode: "streaming" } }), { status: 200 }),
    new Response("{}", { status: 401 }),
  ];
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAuthHeader: async () => ({ Authorization: "Bearer token-a" }),
    proxyFetch: async () => responses.shift(),
    logger: { error() {} },
    configPath: "stt-config",
  });

  assert.deepEqual(await handler({ sender: {} }), {
    success: true,
    dictation: { mode: "streaming" },
  });
  assert.deepEqual(await handler({ sender: {} }), {
    success: false,
    error: "Session expired",
    code: "AUTH_EXPIRED",
    status: 401,
  });
});

test("the note-recording-config handler requests its route with the auth header", async () => {
  let requestedUrl = null;
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAuthHeader: async () => ({ Authorization: "Bearer token-a" }),
    proxyFetch: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.headers.Authorization, "Bearer token-a");
      return new Response(JSON.stringify({ providers: [] }), { status: 200 });
    },
    logger: { error() {} },
    configPath: "note-recording-config",
  });

  assert.deepEqual(await handler({ sender: {} }), { success: true, providers: [] });
  assert.equal(requestedUrl, "https://api.openwhispr.test/api/note-recording-config");
});

test("the note-recording-config handler returns a structured failure instead of null", async () => {
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAuthHeader: async () => ({ Authorization: "Bearer token-a" }),
    proxyFetch: async () =>
      new Response(
        JSON.stringify({ error: "Blocked by workspace policy", code: "POLICY_RESTRICTED" }),
        { status: 403 }
      ),
    logger: { error() {} },
    configPath: "note-recording-config",
  });

  const result = await handler({ sender: {} });
  assert.equal(result.success, false);
  assert.equal(result.code, "POLICY_RESTRICTED");
  assert.equal(result.status, 403);
  assert.equal(result.error, "Blocked by workspace policy");
});

test("every config refetch bypasses the HTTP cache", async () => {
  const requests = [];
  for (const configPath of ["stt-config", "note-recording-config"]) {
    const handler = createCloudConfigRequestHandler({
      getApiUrl: () => "https://api.openwhispr.test",
      getAuthHeader: async () => ({ Authorization: "Bearer token-a" }),
      proxyFetch: async (url, options) => {
        requests.push({ url, cache: options.cache });
        return new Response("{}", { status: 200 });
      },
      logger: { error() {} },
      configPath,
    });
    await handler({ sender: {} });
  }

  assert.deepEqual(
    requests.map(({ url, cache }) => [url, cache]),
    [
      ["https://api.openwhispr.test/api/stt-config", "no-store"],
      ["https://api.openwhispr.test/api/note-recording-config", "no-store"],
    ]
  );
});
