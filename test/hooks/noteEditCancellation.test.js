const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

for (const boundary of ["note read", "conversation creation", "conversation load"]) {
  test(`switching notes during ${boundary} cancels stale persistence and edits`, async (t) => {
    let root;
    let reasoning;
    t.after(async () => {
      if (root) await React.act(async () => root.unmount());
      reasoning?.destroy();
    });
    const notes = new Map(
      [7, 8].map((id) => [
        id,
        {
          id,
          title: `Note ${id}`,
          content: `Personal ${id}`,
          enhanced_content: "## Decisions Made\nKeep me",
          transcript: "Source",
        },
      ])
    );
    let releaseRead;
    let readStarted;
    const started = new Promise((resolve) => {
      readStarted = resolve;
    });
    const pause = async () => {
      readStarted();
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
    };
    const writes = [];
    let requests = 0;
    const replies = [];
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          getConversationsForNote: async () => [],
          createAgentConversation: async () => {
            if (boundary === "conversation creation") await pause();
            return { id: 1 };
          },
          getAgentConversation: async () => {
            await pause();
            return { id: 99, messages: [{ role: "user", content: "Old conversation" }] };
          },
          addAgentMessage: async (_id, role, text) => {
            if (role === "assistant") replies.push(text);
          },
          getNote: async (id) => {
            if (boundary === "note read") await pause();
            return notes.get(id);
          },
          updateNote: async (id, updates) => {
            writes.push({ id, updates });
            Object.assign(notes.get(id), updates);
            return { success: true };
          },
        },
      },
    });
    const container = installInteractiveDom(t);
    const vite = await createRendererServer(t);
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    useSettingsStore.setState({
      chatAgentMode: "self-hosted",
      chatAgentRemoteUrl: "https://llm.lan/v1",
      chatAgentModel: "qwen3-32b",
    });
    reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
    t.mock.method(
      reasoning,
      "processTextStreamingAI",
      (_messages, _model, _provider, _config, tools) =>
        (async function* () {
          requests += 1;
          await tools.update_note.execute(
            { id: 7, clear_fields: ["summary"] },
            { toolCallId: "edit", messages: [] }
          );
          yield { type: "content", text: "Removed it." };
          yield { type: "done", finishReason: "stop" };
        })()
    );
    const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
    let chat;
    function Harness({ id }) {
      const note = notes.get(id);
      chat = useEmbeddedChat({
        noteId: id,
        folderId: null,
        noteTitle: note.title,
        noteContent: note.content,
        noteSummary: note.enhanced_content,
      });
      return null;
    }
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness, { id: 7 })));
    let sending;
    await React.act(async () => {
      sending =
        boundary === "conversation load"
          ? chat.switchConversation(99)
          : chat.sendMessage("Remove Decisions Made from this summary.");
      await started;
    });
    await React.act(async () => root.render(React.createElement(Harness, { id: 8 })));
    // Returning to the original note must not revive its earlier submission.
    await React.act(async () => root.render(React.createElement(Harness, { id: 7 })));
    await React.act(async () => {
      releaseRead();
      await sending;
    });
    assert.equal(requests, boundary === "note read" ? 1 : 0);
    assert.deepEqual(writes, []);
    assert.deepEqual(replies, []);
    assert.deepEqual(chat.messages, []);
    assert.equal(chat.activeConversationId, null);
    for (const note of notes.values())
      assert.equal(note.enhanced_content, "## Decisions Made\nKeep me");
  });
}
