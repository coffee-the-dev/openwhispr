const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Runs the registered Electron handlers with a real local WebSocket server.
// Only Electron is stubbed.
const handlers = new Map();
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orukeet-dictation-ipc-"));
const selfHostedServer = {
  baseUrl: "https://orukeet.example.test",
  websocketUrl: "wss://orukeet.example.test/v1/audio/transcriptions/stream",
};
const { once, EventEmitter } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");
const { OrukeetStreaming } = require("../../src/helpers/orukeetStreaming");
const AgentStreamRequestRegistry = require("../../src/helpers/agentStreamRequestRegistry");
let server, target;
let refuseCommit = false;
let commitCount = 0;
const event = { sender: new EventEmitter() };
event.sender.send = () => {};
event.sender.id = 1;
const selfHostedOptions = {
  provider: "orukeet",
  mode: "byok",
  model: "orukeet-v0.1.0",
  baseUrl: selfHostedServer.baseUrl,
};

const electronStub = {
  app: {
    getPath: () => userDataDirectory,
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn),
    removeHandler: () => {},
  },
  net: { fetch: async () => assert.fail("self-hosted streaming makes no HTTP requests") },
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

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./orukeetStreaming")
      return {
        OrukeetStreaming: class extends OrukeetStreaming {
          constructor(options) {
            super({
              ...options,
              createSocket: (url, options, protocols) => {
                assert.equal(url, selfHostedServer.websocketUrl);
                assert.equal(options.headers.Authorization, "Bearer test-key");
                return new WebSocket(`ws://127.0.0.1:${server.address().port}`, protocols, options);
              },
            });
          }
        },
      };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const target = {
    sessionId: "test-session",
    _dictationStreaming: null,
    _dictationConnectPromise: null,
    _dictationIdleTimer: null,
    _cloudTranscriptionRequests: new AgentStreamRequestRegistry(),
  };
  return new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
}

test.before(async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "ready",
        channels: 1,
        sample_rate: 16000,
        encoding: "pcm_s16le",
        max_seconds: 600,
      })
    );
    let bytes = 0;
    socket.on("message", (data, binary) => {
      if (binary) bytes += data.length;
      else if (JSON.parse(data).type === "commit") {
        commitCount++;
        if (refuseCommit) {
          if (refuseCommit === "once") refuseCommit = false;
          socket.send(JSON.stringify({ type: "error", code: "capacity", retry_after_ms: 100 }));
          return;
        }
        socket.send(
          JSON.stringify({ type: "language", language: "en", language_confidence: 0.99 })
        );
        socket.send(
          JSON.stringify({
            type: "final",
            text: `Recorded ${bytes} bytes`,
            model: "orukeet-v0.1.0",
            language: "en",
            language_confidence: 0.99,
            language_audio_seconds: 6,
          })
        );
      }
    });
  });
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = buildFakeThis();
  Ctor.prototype.setupHandlers.call(target);
});

test.after(async () => {
  await handlers.get("dictation-realtime-stop")();
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
  Module._load = originalLoad;
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});

test("self-hosted IPC still retries a capacity-refused commit without re-uploading", async (t) => {
  refuseCommit = "once";
  const before = commitCount;
  target.environmentManager = { getCustomTranscriptionKey: () => "test-key" };
  t.after(async () => {
    refuseCommit = false;
    delete target.environmentManager;
    await handlers.get("dictation-realtime-stop")();
  });

  const start = await handlers.get("dictation-realtime-start")(event, selfHostedOptions);
  assert.equal(start.success, true);
  handlers.get("dictation-realtime-send")(event, Buffer.alloc(640));
  const final = await handlers.get("dictation-realtime-finalize")();

  assert.equal(final.success, true);
  assert.equal(final.text, "Recorded 640 bytes");
  assert.equal(commitCount - before, 2);
});
