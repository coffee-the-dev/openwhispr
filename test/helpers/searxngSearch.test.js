const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeSearxngBaseUrl,
  clampNumResults,
  buildSearxngSearchUrl,
  mapSearxngResponse,
  searxngSearch,
} = require("../../src/helpers/searxngSearch.js");

test("normalizes the instance URL to its base", () => {
  assert.equal(normalizeSearxngBaseUrl("https://search.lan/"), "https://search.lan");
  assert.equal(normalizeSearxngBaseUrl("search.lan"), "https://search.lan");
  assert.equal(normalizeSearxngBaseUrl("https://host.lan/searx/search"), "https://host.lan/searx");
  assert.equal(normalizeSearxngBaseUrl("http://192.168.1.5:8888"), "http://192.168.1.5:8888");
  assert.equal(normalizeSearxngBaseUrl("http://searx.local"), "http://searx.local");
});

test("refuses plain HTTP on public hosts and malformed URLs", () => {
  assert.throws(() => normalizeSearxngBaseUrl("http://search.example.com"), {
    errorCode: "httpsRequired",
  });
  assert.throws(() => normalizeSearxngBaseUrl("http://10.example.com"), {
    errorCode: "httpsRequired",
  });
  assert.throws(() => normalizeSearxngBaseUrl(""), { errorCode: "urlRequired" });
  assert.throws(() => normalizeSearxngBaseUrl("ftp://host.lan"), { errorCode: "invalidUrl" });
  assert.throws(() => normalizeSearxngBaseUrl("https://user:pw@host.lan"), {
    errorCode: "invalidUrl",
  });
});

test("clamps the result count to 1-10", () => {
  assert.equal(clampNumResults(undefined), 5);
  assert.equal(clampNumResults(0), 1);
  assert.equal(clampNumResults(3.7), 3);
  assert.equal(clampNumResults(50), 10);
  assert.equal(clampNumResults("nope"), 5);
});

test("builds the search URL with only the query and supported options", () => {
  const url = new URL(
    buildSearxngSearchUrl("https://search.lan/", "rust & go?", {
      timeRange: "week",
      language: "en-US",
      categories: "news",
      pageno: 2,
      safesearch: 1,
    })
  );
  assert.equal(url.origin + url.pathname, "https://search.lan/search");
  assert.equal(url.searchParams.get("q"), "rust & go?");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("time_range"), "week");
  assert.equal(url.searchParams.get("language"), "en-US");
  assert.equal(url.searchParams.get("categories"), "news");
  assert.equal(url.searchParams.get("pageno"), "2");
  assert.equal(url.searchParams.get("safesearch"), "1");

  const bare = new URL(buildSearxngSearchUrl("https://h.lan", "q", { timeRange: "decade" }));
  assert.deepEqual([...bare.searchParams.keys()].sort(), ["format", "q"]);
});

test("maps results, answers and the first infobox", () => {
  const long = "x".repeat(900);
  const mapped = mapSearxngResponse(
    {
      results: [
        {
          title: "  One ",
          url: "https://a.example/1",
          content: " first\n snippet ",
          publishedDate: "2026-01-02T00:00:00",
          engine: "duckduckgo",
          score: 3,
        },
        { title: "No URL", content: "dropped" },
        { title: "Two", url: "https://a.example/2", content: long, publishedDate: null },
        { title: "Three", url: "https://a.example/3" },
      ],
      answers: ["42", { answer: "Forty-two", url: "https://a.example" }, { nope: 1 }],
      infoboxes: [
        {
          infobox: "Answer",
          content: "The answer.",
          urls: [{ title: "Wiki", url: "https://wiki.example" }],
        },
        { infobox: "Second" },
      ],
    },
    2
  );

  assert.deepEqual(mapped.results, [
    {
      title: "One",
      url: "https://a.example/1",
      text: "first snippet",
      publishedDate: "2026-01-02T00:00:00",
    },
    { title: "Two", url: "https://a.example/2", text: "x".repeat(500), publishedDate: null },
  ]);
  assert.deepEqual(mapped.answers, ["42", "Forty-two"]);
  assert.deepEqual(mapped.infobox, {
    title: "Answer",
    text: "The answer.",
    url: "https://wiki.example",
  });
});

test("omits empty answers and infoboxes", () => {
  const mapped = mapSearxngResponse({ results: [], answers: [], infoboxes: [] });
  assert.deepEqual(mapped, { results: [] });
  assert.deepEqual(mapSearxngResponse(null), { results: [] });
});

test("searches with a GET that carries no credentials", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ results: [{ title: "T", url: "https://r.example", content: "c" }] }),
    };
  };
  const result = await searxngSearch(
    { baseUrl: "https://search.lan", query: " openwhispr ", numResults: 3, timeRange: "day" },
    { fetchImpl }
  );
  assert.equal(result.success, true);
  assert.equal(result.results.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://search.lan/search?q=openwhispr&format=json&time_range=day"
  );
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json" });
  assert.equal(calls[0].init.body, undefined);
  assert.ok(calls[0].init.signal);
});

test("reports HTTP, JSON, validation and network failures by code", async () => {
  const status = (code) => async () => ({ ok: false, status: code });
  const run = (fetchImpl, baseUrl = "https://h.lan", query = "q") =>
    searxngSearch({ baseUrl, query }, { fetchImpl });

  assert.equal((await run(status(403))).errorCode, "jsonDisabled");
  assert.equal((await run(status(429))).errorCode, "rateLimited");
  assert.equal((await run(status(500))).errorCode, "serverStatus");
  assert.equal(
    (
      await run(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }))
    ).errorCode,
    "invalidResponse"
  );
  assert.equal(
    (
      await run(async () => {
        throw new TypeError("fetch failed");
      })
    ).errorCode,
    "network"
  );

  let fetched = false;
  const spy = async () => {
    fetched = true;
    return { ok: true, json: async () => ({}) };
  };
  assert.equal((await run(spy, "http://public.example.com")).errorCode, "httpsRequired");
  assert.equal((await run(spy, "https://h.lan", "   ")).errorCode, "queryRequired");
  assert.equal(fetched, false);
});

test("aborts a request that outlives the timeout", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const result = await searxngSearch(
    { baseUrl: "https://h.lan", query: "slow" },
    { fetchImpl, timeoutMs: 10 }
  );
  assert.deepEqual(result, {
    success: false,
    error: "SearXNG did not respond in time.",
    errorCode: "timeout",
  });
});
