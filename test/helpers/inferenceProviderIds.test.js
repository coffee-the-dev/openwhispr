const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const modelData = require("../../src/models/modelRegistryData.json");

// PROVIDER_REGISTRY is TypeScript, so node --test can't require it. Parse its
// keys from source the way secretKeys.test.js mirrors preload's inlined list.
function inferenceProviderIds() {
  const src = fs.readFileSync(
    path.join(__dirname, "../../src/services/ai/inferenceProviders/index.ts"),
    "utf8"
  );
  const block = src.match(/PROVIDER_REGISTRY[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(block, "PROVIDER_REGISTRY declared in inferenceProviders/index.ts");
  const ids = [...block[1].matchAll(/^\s*([A-Za-z][\w-]*):/gm)].map((m) => m[1]);
  assert.ok(ids.length > 0, "parsed at least one provider id");
  return ids;
}

test("inference runs only on the local runtime or a self-hosted server", () => {
  assert.deepEqual(inferenceProviderIds().sort(), ["lan", "local"]);
});

test("the registry ships no cloud or enterprise catalogs", () => {
  assert.equal(modelData.cloudProviders, undefined);
  assert.equal(modelData.enterpriseProviders, undefined);
});

test("local catalog ids never shadow an inference provider id", () => {
  // processText routes any catalog family id (qwen, gemma, …) to the llama.cpp
  // "local" provider, so a family named "lan" would silently leave the device.
  const handlers = inferenceProviderIds();
  const localIds = modelData.localProviders.map((p) => p.id);
  assert.ok(localIds.length > 0, "local catalog is non-empty");

  for (const id of localIds) {
    assert.ok(!handlers.includes(id), `local catalog id "${id}" shadows an inference provider`);
  }
});
