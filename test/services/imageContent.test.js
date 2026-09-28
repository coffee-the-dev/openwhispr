const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/imageContent.ts");

test("a screenshot becomes an OpenAI image_url data-URL part", async () => {
  const { buildUserContent } = await load();
  assert.equal(buildUserContent("hi"), "hi");
  assert.equal(buildUserContent("hi", { mediaType: "image/jpeg", data: "" }), "hi");
  assert.deepEqual(buildUserContent("what is this?", { mediaType: "image/jpeg", data: "QUJD" }), [
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
  ]);
});

test("AI SDK image parts are rewritten for the raw SSE request", async () => {
  const { toOpenAIChatMessages, hasImageContent } = await load();
  const messages = [
    { role: "system", content: "sys" },
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", image: "QUJD", mediaType: "image/png" },
      ],
    },
  ];
  assert.equal(hasImageContent(messages), true);
  assert.equal(hasImageContent([{ role: "user", content: "text" }]), false);
  assert.deepEqual(toOpenAIChatMessages(messages), [
    { role: "system", content: "sys" },
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ],
    },
  ]);
  // The caller's messages (which may be kept in history) are not mutated.
  assert.equal(messages[1].content[1].type, "image");
});

test("an existing data URL is passed through", async () => {
  const { imageDataUrl } = await load();
  assert.equal(
    imageDataUrl({ mediaType: "image/png", data: "data:image/webp;base64,AAA" }),
    "data:image/webp;base64,AAA"
  );
});
