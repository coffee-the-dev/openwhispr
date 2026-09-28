const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/selfHostedDefaultModel.ts");

test("a chosen model wins without asking the server", async () => {
  const { resolveSelfHostedModel } = await load();
  let calls = 0;
  const list = async () => {
    calls += 1;
    return { success: true, models: ["x"] };
  };
  assert.equal(await resolveSelfHostedModel("https://v/v1", "", " glm ", list), "glm");
  assert.equal(calls, 0);
});

test("an empty model resolves to the server's first listed id, once per server", async () => {
  const { resolveSelfHostedModel, clearSelfHostedModelCache } = await load();
  clearSelfHostedModelCache();
  const seen = [];
  const list = async (config) => {
    seen.push(config);
    return { success: true, models: ["GLM-5.3-Flash-EXL3", "qwen3.8-flash-next"] };
  };
  assert.equal(await resolveSelfHostedModel("https://v/v1", "k", "", list), "GLM-5.3-Flash-EXL3");
  assert.equal(await resolveSelfHostedModel("https://v/v1", "k", "", list), "GLM-5.3-Flash-EXL3");
  assert.deepEqual(seen, [{ baseUrl: "https://v/v1", apiKey: "k" }]);
});

test("a server that lists nothing yields an empty model and is asked again later", async () => {
  const { resolveSelfHostedModel, clearSelfHostedModelCache } = await load();
  clearSelfHostedModelCache();
  let calls = 0;
  const list = async () => {
    calls += 1;
    return { success: false, models: [] };
  };
  assert.equal(await resolveSelfHostedModel("https://down/v1", "", "", list), "");
  assert.equal(await resolveSelfHostedModel("https://down/v1", "", "", list), "");
  assert.equal(calls, 2);
  assert.equal(await resolveSelfHostedModel("", "", "", list), "");
});
