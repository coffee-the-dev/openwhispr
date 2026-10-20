const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Captures every ipcMain.handle registration and every net.fetch request so the
// registered handler closures can be invoked directly against a fake `this`.
const handlers = new Map();
const fetches = [];
let fetchResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: "transcribed" }),
  text: async () => JSON.stringify({ text: "transcribed" }),
});

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: {
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      return fetchResponse(String(url), init);
    },
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

// A 44-byte RIFF header is enough for isWavFormat, which only sniffs the magic.
const WAV_BUFFER = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(32),
]);
const CONVERTED_WAV = Buffer.concat([WAV_BUFFER, Buffer.from("converted")]);

// Conversion is mocked rather than run: spawning ffmpeg from a unit test would
// make it slow and dependent on the runner having a usable binary.
const wavConversions = [];
let convertBehavior = async () => CONVERTED_WAV;

const textUpdates = [];
const statusUpdates = [];
let parakeetBehavior = async () => ({ success: true, text: "local text" });
let whisperBehavior = async () => ({ success: true, text: "whisper text" });

// Kept installed for the whole file: ffmpegUtils is require()d lazily at
// handler invocation time, not at module load.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
    if (request === "./ffmpegUtils") {
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        ...real,
        convertBufferToWav: async (buffer, options) => {
          wavConversions.push(buffer);
          return convertBehavior(buffer, options);
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by the retry handler can be an inert stub.
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const dbRows = new Map([
    [7, { id: 7, audio_duration_ms: 1200 }],
    [8, { id: 8, audio_duration_ms: 1200 }],
  ]);
  const target = {
    sessionId: "test-session",
    audioStorageManager: {
      // 7 is a stored WebM recording, 8 one already in WAV.
      getAudioBuffer: (id) => (id === 7 ? Buffer.from([1, 2, 3]) : id === 8 ? WAV_BUFFER : null),
    },
    databaseManager: {
      updateTranscriptionText: (id, text) => textUpdates.push({ id, text }),
      updateTranscriptionStatus: (id, status) => statusUpdates.push({ id, status }),
      updateTranscriptionAudio: () => {},
      getTranscriptionById: (id) => dbRows.get(id),
    },
    parakeetManager: {
      transcribeLocalParakeet: (buffer, options) => parakeetBehavior(buffer, options),
    },
    whisperManager: {
      serverManager: { isAvailable: () => true },
      transcribeLocalWhisper: (buffer, options) => whisperBehavior(buffer, options),
    },
    _resolveWhisperVadOptions: () => ({}),
    _uploadCancelRegistry: {
      register: () => ({ signal: new AbortController().signal, release: () => {} }),
    },
    environmentManager: {
      getCustomTranscriptionKey: () => selfHostedKey,
    },
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let selfHostedKey = "sk-lan";
let retryHandler;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(buildFakeThis());
  retryHandler = handlers.get("retry-transcription");
  assert.ok(retryHandler, "retry-transcription must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

const invoke = (settings, id = 7) => retryHandler({ sender: {} }, id, settings);

const SELF_HOSTED_SETTINGS = {
  useLocalWhisper: false,
  transcriptionMode: "self-hosted",
  remoteTranscriptionUrl: "http://192.168.1.20:8000/v1",
  remoteTranscriptionModel: "whisper-1",
  preferredLanguage: "de",
};

const uploadedPart = () => fetches[0].init.body.get("file");

test("retry: self-hosted posts to the configured server with the saved key", async () => {
  fetches.length = 0;
  const result = await invoke(SELF_HOSTED_SETTINGS);
  assert.equal(result.success, true);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "http://192.168.1.20:8000/v1/audio/transcriptions");
  assert.equal(fetches[0].init.headers.Authorization, "Bearer sk-lan");
  assert.equal(fetches[0].init.body.get("model"), "whisper-1");
  assert.equal(fetches[0].init.body.get("language"), "de");
});

test("retry: a self-hosted server without a saved key gets no Authorization header", async () => {
  fetches.length = 0;
  selfHostedKey = "";
  try {
    const result = await invoke(SELF_HOSTED_SETTINGS);
    assert.equal(result.success, true);
    assert.deepEqual(fetches[0].init.headers, {});
  } finally {
    selfHostedKey = "sk-lan";
  }
});

test("retry: an unconfigured self-hosted server fails closed with a coded error", async () => {
  fetches.length = 0;
  for (const remoteTranscriptionUrl of ["", "not a url", "http://example.com/v1"]) {
    const result = await invoke({ ...SELF_HOSTED_SETTINGS, remoteTranscriptionUrl });
    assert.equal(result.success, false, remoteTranscriptionUrl);
    assert.equal(result.code, "SELF_HOSTED_NOT_CONFIGURED", remoteTranscriptionUrl);
  }
  assert.equal(fetches.length, 0);
});

test("retry: a stored WebM is re-encoded before reaching the self-hosted server", async () => {
  // Without this the renderer-side fix covers fresh dictations only, and every
  // retry of a recording that failed for the container reason fails again.
  fetches.length = 0;
  wavConversions.length = 0;

  const result = await invoke(SELF_HOSTED_SETTINGS);

  assert.equal(result.success, true);
  assert.equal(wavConversions.length, 1, "the stored container must be converted");
  const part = uploadedPart();
  assert.equal(part.name, "audio.wav");
  assert.equal(part.type, "audio/wav");
  assert.equal(part.size, CONVERTED_WAV.length, "the converted bytes are what gets uploaded");
});

test("retry: audio already in WAV is uploaded untouched", async () => {
  fetches.length = 0;
  wavConversions.length = 0;

  const result = await invoke(SELF_HOSTED_SETTINGS, 8);

  assert.equal(result.success, true);
  assert.equal(wavConversions.length, 0, "re-encoding WAV would only cost time");
  assert.equal(uploadedPart().size, WAV_BUFFER.length);
});

test("retry: WAV expansion preserves uploads that fit the upload limit", async (t) => {
  for (const wavSize of [25 * 1024 * 1024, 25 * 1024 * 1024 + 1]) {
    await t.test(`${wavSize} converted bytes`, async () => {
      fetches.length = 0;
      const converted = Buffer.alloc(wavSize);
      WAV_BUFFER.copy(converted);
      convertBehavior = async () => converted;
      try {
        const result = await invoke(SELF_HOSTED_SETTINGS);
        assert.equal(result.success, true);
        const part = uploadedPart();
        const fits = wavSize === 25 * 1024 * 1024;
        assert.equal(part.type, fits ? "audio/wav" : "audio/webm");
        assert.equal(part.name, fits ? "audio.wav" : "audio.webm");
        assert.deepEqual(
          Buffer.from(await part.arrayBuffer()),
          fits ? converted : Buffer.from([1, 2, 3])
        );
      } finally {
        convertBehavior = async () => CONVERTED_WAV;
      }
    });
  }
});

test("retry: a conversion failure falls open to the stored container", async () => {
  fetches.length = 0;
  wavConversions.length = 0;
  convertBehavior = async () => {
    throw new Error("ffmpeg missing");
  };

  try {
    const result = await invoke(SELF_HOSTED_SETTINGS);
    assert.equal(result.success, true, "a failed re-encode must not fail the retry");
    const part = uploadedPart();
    assert.equal(part.name, "audio.webm");
    assert.equal(part.type, "audio/webm");
  } finally {
    convertBehavior = async () => CONVERTED_WAV;
  }
});

test("retry: local mode never reaches the network, even with a leftover server URL", async () => {
  fetches.length = 0;
  await invoke({ ...SELF_HOSTED_SETTINGS, transcriptionMode: "local", useLocalWhisper: true });
  assert.equal(fetches.length, 0);
});

const PARAKEET_SETTINGS = {
  transcriptionMode: "local",
  useLocalWhisper: true,
  localTranscriptionProvider: "nvidia",
  parakeetModel: "parakeet-tdt-0.6b-v3",
};
const WHISPER_SETTINGS = {
  transcriptionMode: "local",
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
};

async function withLocalResult(behavior, settings, run) {
  const key = settings === WHISPER_SETTINGS ? "whisper" : "parakeet";
  const original = key === "whisper" ? whisperBehavior : parakeetBehavior;
  if (key === "whisper") whisperBehavior = behavior;
  else parakeetBehavior = behavior;
  textUpdates.length = 0;
  statusUpdates.length = 0;
  try {
    return await run(await invoke(settings));
  } finally {
    if (key === "whisper") whisperBehavior = original;
    else parakeetBehavior = original;
  }
}

test("retry: a clean local decode reports no warning", async () => {
  await withLocalResult(
    async () => ({ success: true, text: "local text" }),
    PARAKEET_SETTINGS,
    (result) => {
      assert.equal(result.success, true);
      assert.equal("warning" in result, false);
      assert.deepEqual(textUpdates, [{ id: 7, text: "local text" }]);
    }
  );
});

test("retry: a truncated Parakeet decode keeps its text and returns the warning", async () => {
  await withLocalResult(
    async () => ({ success: true, text: "first half", warning: "truncated" }),
    PARAKEET_SETTINGS,
    (result) => {
      assert.equal(result.success, true);
      assert.equal(result.warning, "truncated", "the renderer needs it for the partial toast");
      assert.deepEqual(textUpdates, [{ id: 7, text: "first half" }]);
      assert.deepEqual(statusUpdates, [{ id: 7, status: "completed" }]);
    }
  );
});

test("retry: an all-empty Parakeet decode reports the invalid response, not a missing engine", async () => {
  await withLocalResult(
    async () => ({
      success: false,
      error: "invalid_response",
      message: "Transcription engine returned an unexpected response",
    }),
    PARAKEET_SETTINGS,
    (result) => {
      assert.equal(result.success, false);
      assert.equal(result.code, "INVALID_RESPONSE");
      assert.equal(result.messageKey, "controlPanel.history.retryErrors.invalidResponse");
      assert.equal(result.error, "Transcription engine returned an unexpected response");
      assert.equal(textUpdates.length, 0, "a failed retry must leave the row alone");
      assert.equal(statusUpdates.length, 0);
    }
  );
});

test("retry: no speech from a local engine is reported as such", async (t) => {
  for (const [name, settings, failure] of [
    [
      "parakeet",
      PARAKEET_SETTINGS,
      { success: false, code: "NO_SPEECH_DETECTED", message: "No audio detected" },
    ],
    ["whisper", WHISPER_SETTINGS, { success: false, message: "No audio detected" }],
  ]) {
    await t.test(name, () =>
      withLocalResult(
        async () => failure,
        settings,
        (result) => {
          assert.equal(result.success, false);
          assert.equal(result.code, "NO_SPEECH_DETECTED");
          assert.equal(result.messageKey, "notes.upload.noSpeechDetected");
          assert.equal(textUpdates.length, 0);
        }
      )
    );
  }
});

test("retry: an unclassified local failure keeps the engine's own message", async () => {
  await withLocalResult(
    async () => ({ success: false, error: "decode_failed", message: "Decoder crashed" }),
    PARAKEET_SETTINGS,
    (result) => {
      assert.equal(result.success, false);
      assert.equal(result.error, "Decoder crashed");
      assert.equal(result.messageKey, undefined);
    }
  );
});

test("retry: an empty answer from the self-hosted server is no speech, not a missing engine", async (t) => {
  const originalFetchResponse = fetchResponse;
  t.after(() => {
    fetchResponse = originalFetchResponse;
  });
  fetchResponse = () => ({ ok: true, status: 200, json: async () => ({ text: "" }) });
  textUpdates.length = 0;
  const result = await invoke(SELF_HOSTED_SETTINGS);
  assert.equal(result.success, false);
  assert.equal(result.code, "NO_SPEECH_DETECTED");
  assert.equal(result.messageKey, "notes.upload.noSpeechDetected");
  assert.equal(textUpdates.length, 0);
});

const fsNode = require("node:fs");
const osNode = require("node:os");
const pathNode = require("node:path");

const uploadTempFile = pathNode.join(osNode.tmpdir(), "openwhispr-upload-handler-test.webm");

const invokeUpload = (payload) => {
  const uploadHandler = handlers.get("transcribe-audio-file-self-hosted");
  assert.ok(uploadHandler, "transcribe-audio-file-self-hosted must be registered");
  fsNode.writeFileSync(uploadTempFile, Buffer.from([1, 2, 3, 4]));
  return uploadHandler({ sender: {} }, { filePath: uploadTempFile, ...payload });
};

// An uploaded file is frequently not in the dictation language, and a wrong hint
// silently mistranscribes it, so uploads auto-detect even when the user has
// pinned a preferred language for dictation.
test("upload: self-hosted sends the model and key but never a language", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    language: "de",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://192.168.1.20:8000/v1",
    remoteTranscriptionModel: "whisper-1",
  });
  assert.equal(result.success, true);
  assert.equal(result.text, "transcribed");
  assert.equal(fetches[0].url, "http://192.168.1.20:8000/v1/audio/transcriptions");
  assert.equal(fetches[0].init.headers.Authorization, "Bearer sk-lan");
  const body = fetches[0].init.body.toString();
  assert.match(body, /name="model"\r\n\r\nwhisper-1/);
  assert.doesNotMatch(body, /name="language"/);
});

test("upload: an unconfigured or local route fails closed before any request", async () => {
  fetches.length = 0;
  for (const payload of [
    { transcriptionMode: "self-hosted", remoteTranscriptionUrl: "" },
    { transcriptionMode: "local", remoteTranscriptionUrl: "http://192.168.1.20:8000/v1" },
  ]) {
    const result = await invokeUpload(payload);
    assert.equal(result.success, false, JSON.stringify(payload));
  }
  assert.equal(fetches.length, 0);
});

test("upload: timed segments come back when the server honors verbose_json", async () => {
  fetches.length = 0;
  const previous = fetchResponse;
  fetchResponse = () => {
    const payload = {
      text: "Hello. Bye.",
      segments: [
        { text: "Hello.", start: 0, end: 1 },
        { text: "Bye.", start: 1, end: 2 },
      ],
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  try {
    const result = await invokeUpload({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://verbose.lan/v1",
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.segments, [
      { text: "Hello.", start: 0, end: 1 },
      { text: "Bye.", start: 1, end: 2 },
    ]);
    const body = fetches[0].init.body.toString();
    assert.match(body, /name="response_format"\r\n\r\nverbose_json/);
    assert.match(body, /name="timestamp_granularities\[\]"\r\n\r\nsegment/);
  } finally {
    fetchResponse = previous;
  }
});

test("upload: a server that rejects verbose_json is retried as plain json", async () => {
  fetches.length = 0;
  const previous = fetchResponse;
  fetchResponse = (_url, init) => {
    const verbose = init.body.toString().includes("verbose_json");
    return verbose
      ? { ok: false, status: 400, text: async () => JSON.stringify({ error: "bad format" }) }
      : { ok: true, status: 200, text: async () => JSON.stringify({ text: "plain text" }) };
  };
  try {
    const result = await invokeUpload({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://textonly.lan/v1",
    });
    assert.deepEqual(
      { success: result.success, text: result.text },
      {
        success: true,
        text: "plain text",
      }
    );
    assert.equal(result.segments, undefined);
    assert.equal(fetches.length, 2);
  } finally {
    fetchResponse = previous;
  }
});

// Electron's net.fetch rejects with a plain Error whose message is the Chromium
// net error and no code; the self-hosted handlers must classify it before replying.
async function withFetchRejecting(message, run) {
  const originalFetchResponse = fetchResponse;
  fetchResponse = () => {
    throw new Error(message);
  };
  try {
    return await run();
  } finally {
    fetchResponse = originalFetchResponse;
  }
}

test("retry: a self-hosted timeout names the user's server", async () => {
  const result = await withFetchRejecting("net::ERR_CONNECTION_TIMED_OUT", () =>
    invoke(SELF_HOSTED_SETTINGS)
  );
  assert.equal(result.code, "PROVIDER_TIMEOUT");
  assert.equal(result.messageKey, "providerErrors.selfHosted.timeout");
});

test("retry: a cancelled request (net::ERR_ABORTED) is not classified", async () => {
  const result = await withFetchRejecting("net::ERR_ABORTED", () => invoke(SELF_HOSTED_SETTINGS));
  assert.equal(result.success, false);
  assert.equal(result.messageKey, undefined);
  assert.equal(result.error, "net::ERR_ABORTED");
});

test("upload: an HTTP failure logs its status and a redacted body", async (t) => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const warnings = [];
  t.mock.method(debugLogger, "warn", (message, meta) => warnings.push({ message, meta }));
  const originalFetchResponse = fetchResponse;
  t.after(() => {
    fetchResponse = originalFetchResponse;
  });
  const body = '{"error":{"message":"Incorrect API key provided: sk-proj-leakedKey12345"}}';
  fetchResponse = () => ({
    ok: false,
    status: 401,
    headers: new Headers(),
    text: async () => body,
    json: async () => JSON.parse(body),
  });

  const result = await invokeUpload({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://192.168.1.20:8000/v1",
    remoteTranscriptionModel: "whisper-1",
  });

  assert.equal(result.code, "PROVIDER_AUTH_FAILED");
  const failure = warnings.find(
    ({ message }) => message === "Self-hosted file transcription failed"
  );
  assert.ok(failure, "the failure must be logged");
  assert.equal(failure.meta.status, 401);
  assert.match(failure.meta.body, /Incorrect API key provided/);
  assert.equal(failure.meta.body.includes("sk-proj-leakedKey12345"), false);
});
