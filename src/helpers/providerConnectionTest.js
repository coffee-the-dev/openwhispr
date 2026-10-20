// Renderers translate errorCode via onboarding.rehaul.provider.errors.*; the
// English `error` string stays for logs and older callers.
class ConnectionTestError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.errorCode = errorCode;
  }
}

// --- CommonJS mirror of the URL helpers in src/config/constants.ts ---
// This file runs in the main process, which cannot import that Vite/TS
// module (it reads import.meta.env). Keep these in sync with
// normalizeBaseUrl / getModelListBaseCandidates over there.

// Mirror of isPrivateHost/parseIPv4Literal in src/utils/urlUtils.ts (same
// main-process constraint as above): the runtime refuses plain HTTP on public
// hosts via isSecureHttpEndpoint, so the connection test must refuse the same
// URLs or a passing test commits a config every real request rejects.

function parseIPv4Literal(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }

  return octets;
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h === "0.0.0.0") return true;
  if (h === "::1") return true;

  const ipv4 = parseIPv4Literal(h);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
  }

  const isIPv6 = h.includes(":");
  if (isIPv6 && (/^fe[89ab]/.test(h) || h.startsWith("fc") || h.startsWith("fd"))) return true;
  if (h.endsWith(".local")) return true;
  if (h.endsWith(".ts.net")) return true;

  return false;
}

function splitUrlDecorators(value) {
  let path = value;
  let hash = "";
  const hashIndex = path.indexOf("#");
  if (hashIndex >= 0) {
    hash = path.slice(hashIndex);
    path = path.slice(0, hashIndex);
  }
  let query = "";
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) {
    query = path.slice(queryIndex);
    path = path.slice(0, queryIndex);
  }
  return { path, query, hash };
}

function joinUrlDecorators(path, query, hash) {
  return `${path}${query}${hash}`;
}

function normalizeBaseUrl(value) {
  if (!value) return "";

  const trimmed = String(value).trim();
  if (!trimmed) return "";

  const { path: rawPath, query, hash } = splitUrlDecorators(trimmed);
  let normalized = rawPath;

  const suffixReplacements = [
    [/\/v1\/chat\/completions$/i, "/v1"],
    [/\/chat\/completions$/i, ""],
    [/\/v1\/responses$/i, "/v1"],
    [/\/responses$/i, ""],
    [/\/v1\/models$/i, "/v1"],
    [/\/models$/i, ""],
    [/\/v1\/audio\/transcriptions$/i, "/v1"],
    [/\/audio\/transcriptions$/i, ""],
    [/\/v1\/audio\/translations$/i, "/v1"],
    [/\/audio\/translations$/i, ""],
    [/\/v1\/audio\/diarizations$/i, "/v1"],
    [/\/audio\/diarizations$/i, ""],
  ];

  for (const [pattern, replacement] of suffixReplacements) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, replacement).replace(/\/+$/, "");
    }
  }

  return joinUrlDecorators(normalized.replace(/\/+$/, ""), query, hash);
}

// Reference: getModelListBaseCandidates in src/config/constants.ts.
// Self-hosted servers (LM Studio, Ollama, vLLM) serve the API under /v1 even
// when users enter the bare origin, and LM Studio's native REST base
// (/api/v1 or /api/v0) has its OpenAI-compatible sibling at /v1.
function getModelListBaseCandidates(base) {
  const normalized = normalizeBaseUrl(base);
  if (!normalized) return [];
  const { path, query, hash } = splitUrlDecorators(normalized);
  const nativeApiMatch = path.match(/^(.+?)\/api\/v[01]$/i);
  if (nativeApiMatch) {
    return [normalized, joinUrlDecorators(`${nativeApiMatch[1]}/v1`, query, hash)];
  }
  if (path.endsWith("/v1")) return [normalized];
  return [normalized, joinUrlDecorators(`${path}/v1`, query, hash)];
}

function buildModelEndpoints(base) {
  return getModelListBaseCandidates(base).map((candidate) => {
    const { path, query, hash } = splitUrlDecorators(candidate);
    return joinUrlDecorators(`${path}/models`, query, hash);
  });
}

// Where the app sends a self-hosted server's audio: buildApiUrl(normalizeBaseUrl(url),
// "/audio/transcriptions") in src/config/constants.ts and transcriptionRoute.ts.
// buildApiUrl normalises its base again, which strips a suffix a trailing slash hid
// from the first pass, so this address takes the same two passes.
function buildTranscriptionEndpoint(base) {
  const { path, query, hash } = splitUrlDecorators(normalizeBaseUrl(normalizeBaseUrl(base)));
  return joinUrlDecorators(`${path}/audio/transcriptions`, query, hash);
}

// Every connection test targets the user's own OpenAI-compatible server.
function resolveProviderRequest(config) {
  const apiKey = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  const raw = String(config?.baseUrl || "").trim();
  if (!raw) {
    throw new ConnectionTestError("endpointRequired", "Enter an endpoint URL before testing.");
  }
  let parsed;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new ConnectionTestError("invalidUrl", "The endpoint must be a valid URL.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new ConnectionTestError("invalidUrl", "The endpoint must use HTTP or HTTPS.");
  }
  if (parsed.protocol === "http:" && !isPrivateHost(parsed.hostname)) {
    throw new ConnectionTestError(
      "httpsRequired",
      "Public endpoints must use HTTPS. HTTP is only allowed on private addresses."
    );
  }
  const endpoints = buildModelEndpoints(parsed.toString());
  const transcriptionEndpoint = buildTranscriptionEndpoint(parsed.toString());

  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return { endpoint: endpoints[0], endpoints, headers, transcriptionEndpoint };
}

// When several candidate endpoints fail, report the most actionable failure. An answer that
// faults the setup outranks no answer (unverified), so a busy candidate never hides a refused
// key or a missing model. No answer outranks a candidate without a model list, which may only
// be an address the server doesn't use.
const FAILURE_PRIORITY = {
  credentialsRejected: 6,
  providerStatus: 5,
  modelNotFound: 4,
  endpointNotFound: 0,
};
const UNVERIFIED_PRIORITY = { providerStatus: 3, timeout: 2, network: 1 };

function pickFailure(current, next) {
  if (!current) return next;
  const rank = (failure) =>
    (failure.unverified ? UNVERIFIED_PRIORITY : FAILURE_PRIORITY)[failure.errorCode];
  return rank(next) > rank(current) ? next : current;
}

// A server that is slow, busy or down gives no verdict on the settings. Such a failure is
// marked unverified: the app may go ahead with them, and only a later check can tell.
function isUnverifiedStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

const TIMEOUT_FAILURE = {
  errorCode: "timeout",
  error: "The connection test timed out.",
  unverified: true,
};
const NETWORK_FAILURE = {
  errorCode: "network",
  error: "The server could not be reached.",
  unverified: true,
};

function describeStatusFailure(status) {
  if (status === 401 || status === 403) {
    return {
      errorCode: "credentialsRejected",
      error: "The server rejected these credentials.",
      status,
    };
  }
  if (status === 404) {
    return {
      errorCode: "endpointNotFound",
      error: "The endpoint does not expose an OpenAI-compatible model list.",
      status,
    };
  }
  const failure = {
    errorCode: "providerStatus",
    error: `The server returned status ${status}.`,
    status,
  };
  return isUnverifiedStatus(status) ? { ...failure, unverified: true } : failure;
}

function normalizeModelId(value) {
  return String(value || "")
    .trim()
    .replace(/^models\//i, "");
}

function responseModelIds(payload) {
  const models = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

  return models
    .map((model) => (typeof model === "string" ? model : model?.id || model?.name))
    .map(normalizeModelId)
    .filter(Boolean);
}

// An empty or non-JSON body reads as undefined. A body that never arrives (the 12 s cap
// firing, a dropped connection) is not an answer, so its error goes on to probe's catch.
async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function responseOffersModel(response, model) {
  if (!model) return true;
  return responseModelIds(await readJson(response)).includes(normalizeModelId(model));
}

// One request (a GET unless `init` says otherwise) under the 12 s cap. `judge` reads the
// response inside that window, so a body that stalls cannot hold the check past the cap.
async function probe(endpoint, request, fetchImpl, judge, init = { method: "GET" }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchImpl(endpoint, {
      ...init,
      headers: request.headers,
      signal: controller.signal,
    });
    return await judge(response);
  } catch (error) {
    return { failure: error?.name === "AbortError" ? TIMEOUT_FAILURE : NETWORK_FAILURE };
  } finally {
    clearTimeout(timeout);
  }
}

// GET each candidate model-list endpoint in turn. `onResponse` decides what an
// OK response means: `{ result }` ends the probe, `{ failure }` tries the next
// candidate. Resolves `everyListMissing` when every candidate answered 404.
async function probeModelEndpoints(request, onResponse, fetchImpl) {
  let failure = null;
  let everyListMissing = true;
  for (const endpoint of request.endpoints) {
    const outcome = await probe(endpoint, request, fetchImpl, async (response) =>
      response.ok ? onResponse(response) : { failure: describeStatusFailure(response.status) }
    );
    if (outcome.result) return outcome.result;
    everyListMissing = everyListMissing && outcome.failure.status === 404;
    failure = pickFailure(failure, outcome.failure);
  }
  return { success: false, ...failure, everyListMissing };
}

function resolveRequestOrFailure(config) {
  try {
    return { request: resolveProviderRequest(config) };
  } catch (error) {
    return {
      failure: { success: false, errorCode: error.errorCode || "invalidUrl", error: error.message },
    };
  }
}

// The server's model ids, for the model pickers. Runs in the main process so a
// server without CORS headers still lists.
async function listRemoteModels(config, fetchImpl = fetch) {
  const { request, failure } = resolveRequestOrFailure(config);
  if (failure) return { ...failure, models: [] };
  const { everyListMissing: _everyListMissing, ...result } = await probeModelEndpoints(
    request,
    async (response) => {
      let models = [];
      try {
        models = responseModelIds(await response.json());
      } catch {
        models = [];
      }
      if (models.length > 0) return { result: { success: true, models } };
      return {
        failure: { errorCode: "endpointNotFound", error: "The server listed no models." },
      };
    },
    fetchImpl
  );
  return result.success ? result : { ...result, models: [] };
}

async function testProviderConnection(config, fetchImpl = fetch) {
  const { request, failure } = resolveRequestOrFailure(config);
  if (failure) return failure;

  const model = String(config?.model || "").trim();
  const { everyListMissing, ...result } = await probeModelEndpoints(
    request,
    async (response) =>
      (await responseOffersModel(response, model))
        ? { result: { success: true } }
        : {
            failure: {
              errorCode: "modelNotFound",
              error: "The selected model is not available from this server.",
            },
          },
    fetchImpl
  );
  if (!result.success && everyListMissing && config?.scope === "transcription") {
    return testTranscriptionEndpoint(request, model, fetchImpl);
  }
  return result;
}

// A speech-only server may publish no model list. Its transcription address answers a
// request that carries no audio with 400 or 422, which proves the address without
// transcribing anything. The model is not checked.
async function testTranscriptionEndpoint(request, model, fetchImpl) {
  const body = new FormData();
  body.append("model", model);
  const outcome = await probe(
    request.transcriptionEndpoint,
    request,
    fetchImpl,
    async (response) => {
      if (response.status === 400 || response.status === 422) return {};
      if (response.status === 404 || response.status === 405) {
        return {
          failure: {
            errorCode: "transcriptionEndpointNotFound",
            error: "Nothing takes transcriptions at this address.",
            status: response.status,
          },
        };
      }
      return { failure: describeStatusFailure(response.status) };
    },
    { method: "POST", body }
  );
  return outcome.failure ? { success: false, ...outcome.failure } : { success: true };
}

module.exports = {
  resolveProviderRequest,
  testProviderConnection,
  listRemoteModels,
  isPrivateHost,
};
