const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const enTranslations = require("../../src/locales/en/translation.json");

const HTTPS_REQUIRED = enTranslations.reasoning.custom.httpsRequired;

test("ReasoningService entry points guard their endpoints", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-enforcement-test-",
  });

  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");

  await t.test("a local selection without a model fails before dispatch", async () => {
    await assert.rejects(reasoningService.processText("hi", "", null, { provider: "local" }), {
      message: "No reasoning model selected",
    });
  });

  await t.test("a scope's self-hosted endpoint never borrows the cleanup key", async () => {
    useSettingsStore.setState({
      cleanupMode: "self-hosted",
      cleanupRemoteUrl: "https://cleanup.example.com/v1",
      cleanupCustomApiKey: "cleanup-secret",
    });

    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), auth: init?.headers?.Authorization });
      return new Response(JSON.stringify({ error: "expected test stop" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await assert.rejects(
        reasoningService.processText("hi", "other-model", null, {
          lanUrl: "https://other-scope.example.com/v1",
          inferenceScope: "chatIntelligence",
        }),
        { message: "expected test stop" }
      );
      assert.ok(requests.length > 0);
      for (const request of requests) {
        assert.ok(request.url.startsWith("https://other-scope.example.com/v1/"));
        assert.equal(
          request.auth,
          undefined,
          "the cleanup key must not ride to another scope's endpoint"
        );
      }

      // Implicit cleanup runs on its own endpoint with the shared key.
      requests.length = 0;
      await assert.rejects(reasoningService.processText("hi", "cleanup-model"), {
        message: "expected test stop",
      });
      assert.ok(requests.length > 0);
      assert.ok(
        requests.every((request) => request.url.startsWith("https://cleanup.example.com/v1/"))
      );
      assert.ok(requests.some((request) => request.auth === "Bearer cleanup-secret"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test(
    "implicit self-hosted cleanup without a URL never falls back elsewhere",
    async () => {
      useSettingsStore.setState({
        cleanupMode: "self-hosted",
        cleanupRemoteUrl: "",
        cleanupModel: "gpt-4.1",
      });

      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return new Response(null, { status: 500 });
      };

      try {
        await assert.rejects(reasoningService.processText("hi", "gpt-4.1"), {
          message: HTTPS_REQUIRED,
        });
        assert.equal(fetchCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );

  await t.test(
    "self-hosted execution rejects unsafe endpoint schemes before dispatch",
    async () => {
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return new Response(null, { status: 500 });
      };

      try {
        for (const lanUrl of ["http://public.example.com/v1", "ftp://192.168.1.20/v1"]) {
          await assert.rejects(
            reasoningService.processText("hi", "custom-model", null, { lanUrl }),
            { message: HTTPS_REQUIRED }
          );

          const textStream = reasoningService.processTextStreaming(
            [{ role: "user", content: "hi" }],
            "custom-model",
            "lan",
            { systemPrompt: "s", lanUrl }
          );
          await assert.rejects(textStream.next(), { message: HTTPS_REQUIRED });

          const toolStream = reasoningService.processTextStreamingAI(
            [{ role: "user", content: "hi" }],
            "custom-model",
            "lan",
            { systemPrompt: "s", lanUrl },
            {}
          );
          await assert.rejects(toolStream.next(), { message: HTTPS_REQUIRED });
        }

        assert.equal(fetchCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});
