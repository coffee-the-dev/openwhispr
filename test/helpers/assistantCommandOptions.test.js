const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/dictation/assistantCommandOptions.ts");

const PASTE = {
  mode: "paste",
  sessionId: "s",
  restoreClipboard: true,
  allowClipboardFallback: false,
};

function handlers(deliverResult = { pasted: true, copied: false }) {
  const calls = { delivered: [], copied: [] };
  return {
    calls,
    value: {
      deliver: async (delivery, content) => {
        calls.delivered.push({ delivery, content });
        return delivery.mode === "paste" ? deliverResult : { pasted: false, copied: true };
      },
      confirmCopied: (content) => calls.copied.push(content),
    },
  };
}

test("a caret-delivered command pastes its answer", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const h = handlers();
  const built = buildAssistantCommandSendOptions(
    { attachment: null, selectedContext: null, delivery: PASTE },
    h.value
  );

  assert.equal(built.options.suppressResponseContent, true);
  await built.options.onComplete({ assistantId: "a", content: "Answer" });

  assert.equal(h.calls.delivered.length, 1);
  assert.equal(built.wasDelivered(), true);
});

test("the command's screenshot and selection ride along with the send", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const attachment = { image: "base64", mediaType: "image/jpeg" };
  const selectedContext = { text: "selected words", sourceMessageId: "m1" };
  for (const delivery of [PASTE, { mode: "clipboard" }, null]) {
    const built = buildAssistantCommandSendOptions(
      { attachment, selectedContext, delivery },
      handlers().value
    );

    assert.equal(built.options.attachment, attachment);
    assert.equal(built.options.selectedContext, selectedContext);
  }
});

test("a caret answer that falls back to the clipboard confirms the copy", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const h = handlers({ pasted: false, copied: true });
  const built = buildAssistantCommandSendOptions(
    { attachment: null, selectedContext: null, delivery: PASTE },
    h.value
  );

  await built.options.onComplete({ assistantId: "a", content: "Answer" });

  assert.deepEqual(h.calls.copied, ["Answer"]);
  assert.equal(built.wasDelivered(), false);
});

test("a panel command has no delivery hook", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const h = handlers();
  const built = buildAssistantCommandSendOptions(
    { attachment: null, selectedContext: null, delivery: null },
    h.value
  );

  assert.equal(built.options.onComplete, undefined);
  assert.equal(built.options.suppressResponseContent, false);
});

test("a caret-delivered command tells the chat which kind of app it writes into", async () => {
  const { buildAssistantCommandSendOptions } = await load();
  const send = (delivery) =>
    buildAssistantCommandSendOptions(
      { attachment: null, selectedContext: null, delivery },
      handlers().value
    ).options.destinationAppCategory;

  assert.equal(send({ ...PASTE, appCategory: "email" }), "email");
  assert.equal(send(PASTE), undefined);
  assert.equal(send({ mode: "clipboard" }), undefined);
});
