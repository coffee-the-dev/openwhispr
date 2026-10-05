const test = require("node:test");
const assert = require("node:assert/strict");

const resolve = async (settings) => {
  const { resolveDiarizationRoute } = await import("../../src/helpers/diarizationRoute.ts");
  return resolveDiarizationRoute(settings);
};

test("anything but an explicit self-hosted choice diarizes locally", async () => {
  assert.deepEqual(await resolve({}), { transport: "local" });
  assert.deepEqual(await resolve({ mode: "local", url: "https://speech.lan/v1" }), {
    transport: "local",
  });
});

test("self-hosted targets /audio/diarizations under the base URL", async () => {
  assert.deepEqual(await resolve({ mode: "self-hosted", url: " https://vllm.ash.mn/v1/ " }), {
    transport: "http",
    endpoint: "https://vllm.ash.mn/v1/audio/diarizations",
  });
});

test("a pasted full endpoint URL is not doubled", async () => {
  const route = await resolve({
    mode: "self-hosted",
    url: "https://speech.lan/v1/audio/diarizations",
  });
  assert.equal(route.endpoint, "https://speech.lan/v1/audio/diarizations");
});

test("self-hosted fails closed instead of falling back to the local diarizer", async () => {
  assert.equal((await resolve({ mode: "self-hosted", url: "" })).transport, "error");
  assert.equal(
    (await resolve({ mode: "self-hosted", url: "http://speech.example.com/v1" })).transport,
    "error"
  );
});

test("plain HTTP is accepted for private hosts", async () => {
  assert.deepEqual(await resolve({ mode: "self-hosted", url: "http://192.168.1.20:8080/v1" }), {
    transport: "http",
    endpoint: "http://192.168.1.20:8080/v1/audio/diarizations",
  });
});
