// Web search for the agent's web_search tool, backed by the user's own
// SearXNG instance (JSON output must be enabled in its settings.yml). Only the
// query and the search options the model picked are sent; no cookies, keys or
// conversation text.
const { isPrivateHost } = require("./providerConnectionTest");

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 500;
const TIME_RANGES = new Set(["day", "week", "month", "year"]);

class SearxngSearchError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.errorCode = errorCode;
  }
}

/**
 * Normalizes a user-entered instance URL to its base (no trailing slash, no
 * /search suffix). Scheme-less input is read as https. Throws
 * SearxngSearchError for empty, malformed or insecure URLs: plain HTTP is only
 * allowed on private hosts, the same rule as the self-hosted inference URLs.
 */
function normalizeSearxngBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new SearxngSearchError("urlRequired", "Enter a SearXNG URL.");
  let parsed;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new SearxngSearchError("invalidUrl", "The SearXNG URL must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SearxngSearchError("invalidUrl", "The SearXNG URL must use HTTP or HTTPS.");
  }
  if (parsed.protocol === "http:" && !isPrivateHost(parsed.hostname)) {
    throw new SearxngSearchError(
      "httpsRequired",
      "Public hosts must use HTTPS. HTTP is only allowed on private addresses."
    );
  }
  if (parsed.username || parsed.password) {
    throw new SearxngSearchError("invalidUrl", "The SearXNG URL must not contain credentials.");
  }
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/search$/, "");
  return `${parsed.origin}${path}`;
}

function clampNumResults(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_NUM_RESULTS;
  return Math.min(MAX_NUM_RESULTS, Math.max(1, n));
}

function buildSearxngSearchUrl(baseUrl, query, options = {}) {
  const url = new URL(`${normalizeSearxngBaseUrl(baseUrl)}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (TIME_RANGES.has(options.timeRange)) url.searchParams.set("time_range", options.timeRange);
  if (
    typeof options.language === "string" &&
    /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(options.language)
  ) {
    url.searchParams.set("language", options.language);
  }
  if (typeof options.categories === "string" && /^[\w ,-]+$/.test(options.categories)) {
    url.searchParams.set("categories", options.categories);
  }
  const pageno = Math.floor(Number(options.pageno));
  if (Number.isFinite(pageno) && pageno > 1) url.searchParams.set("pageno", String(pageno));
  const safesearch = Number(options.safesearch);
  if ([0, 1, 2].includes(safesearch)) url.searchParams.set("safesearch", String(safesearch));
  return url.toString();
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function mapResult(result) {
  return {
    title: cleanText(result?.title),
    url: typeof result?.url === "string" ? result.url : "",
    text: cleanText(result?.content).slice(0, MAX_TEXT_CHARS),
    publishedDate: typeof result?.publishedDate === "string" ? result.publishedDate : null,
  };
}

// Older SearXNG releases return answers as strings, newer ones as objects.
function mapAnswer(answer) {
  if (typeof answer === "string") return cleanText(answer);
  return cleanText(answer?.answer);
}

function mapInfobox(infobox) {
  if (!infobox || typeof infobox !== "object") return null;
  const title = cleanText(infobox.infobox);
  const text = cleanText(infobox.content).slice(0, MAX_TEXT_CHARS);
  if (!title && !text) return null;
  const firstUrl = Array.isArray(infobox.urls) ? infobox.urls.find((u) => u?.url)?.url : null;
  return { title, text, url: typeof firstUrl === "string" ? firstUrl : null };
}

function mapSearxngResponse(payload, numResults = DEFAULT_NUM_RESULTS) {
  const limit = clampNumResults(numResults);
  const results = (Array.isArray(payload?.results) ? payload.results : [])
    .map(mapResult)
    .filter((r) => r.url)
    .slice(0, limit);
  const answers = (Array.isArray(payload?.answers) ? payload.answers : [])
    .map(mapAnswer)
    .filter(Boolean);
  const infobox = mapInfobox(Array.isArray(payload?.infoboxes) ? payload.infoboxes[0] : null);
  return {
    results,
    ...(answers.length ? { answers } : {}),
    ...(infobox ? { infobox } : {}),
  };
}

function describeStatus(status) {
  if (status === 403) {
    return new SearxngSearchError(
      "jsonDisabled",
      "SearXNG refused the request (403). Enable the json format under search.formats in settings.yml."
    );
  }
  if (status === 429) {
    return new SearxngSearchError(
      "rateLimited",
      "SearXNG rate-limited the request (429). Disable the limiter for this client."
    );
  }
  return new SearxngSearchError("serverStatus", `SearXNG returned HTTP ${status}.`);
}

/**
 * @returns {Promise<{ success: true, results: Array<object>, answers?: string[], infobox?: object }
 *   | { success: false, error: string, errorCode: string }>}
 */
async function searxngSearch(
  { baseUrl, query, numResults, timeRange } = {},
  { fetchImpl = fetch, timeoutMs = SEARCH_TIMEOUT_MS } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const q = String(query || "").trim();
    if (!q) throw new SearxngSearchError("queryRequired", "The search query is empty.");
    const url = buildSearxngSearchUrl(baseUrl, q, { timeRange });
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw describeStatus(response.status);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SearxngSearchError(
        "invalidResponse",
        "SearXNG did not return JSON. Enable the json format under search.formats in settings.yml."
      );
    }
    return { success: true, ...mapSearxngResponse(payload, numResults) };
  } catch (error) {
    if (error instanceof SearxngSearchError) {
      return { success: false, error: error.message, errorCode: error.errorCode };
    }
    if (controller.signal.aborted) {
      return { success: false, error: "SearXNG did not respond in time.", errorCode: "timeout" };
    }
    return {
      success: false,
      error: `Could not reach SearXNG: ${error?.message || "network error"}`,
      errorCode: "network",
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_NUM_RESULTS,
  MAX_NUM_RESULTS,
  SEARCH_TIMEOUT_MS,
  normalizeSearxngBaseUrl,
  clampNumResults,
  buildSearxngSearchUrl,
  mapSearxngResponse,
  searxngSearch,
};
