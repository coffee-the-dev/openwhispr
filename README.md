<p align="center">
  <img src="src/assets/logo.svg" alt="OpenWhispr" width="120" />
</p>

<h1 align="center">OpenWhispr (local-only fork)</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/OpenWhispr/openwhispr?style=flat" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat" alt="Platform" />
</p>

<p align="center">
  Voice dictation, meeting transcription, notes, and a voice assistant that run entirely on your machine or on servers you host on your own network.
</p>

---

This is a fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) with every feature that talks to a third party removed. There is no account, no OpenWhispr Cloud, no bring-your-own-key cloud providers, no telemetry upload, no auto-updater, and no Google or Microsoft calendar sign-in. Speech-to-text and AI run either on-device or against OpenAI-compatible servers on your LAN, web search goes through your own SearXNG instance, and notes can be exported to an Obsidian vault.

The app only contacts hosts you configure, plus model and binary downloads you start. The full list is in [docs/network-allowlist.md](docs/network-allowlist.md).

## Features

- **Voice dictation**: press a global hotkey, speak, and the text is pasted at your cursor. Optional cleanup by an LLM
- **Dictation translation**: a dedicated hotkey that dictates in one language and pastes in another
- **Voice assistant**: a hotkey that sends what you say straight to your assistant. Highlighted text is edited in place, and answers paste at the cursor or stream into a floating panel. It can search your notes, read Apple Calendar, search the web through SearXNG, and optionally see a screenshot of your screen (self-hosted vision models only)
- **Meeting transcription**: auto-detects Zoom, Teams, FaceTime and browser calls, records mic and system audio, suppresses echo, and labels speakers with on-device diarization and voice fingerprints. Apple Calendar events are linked on macOS
- **Notes**: folders, keyword and on-device semantic search (Qdrant + MiniLM), AI summaries and actions
- **Obsidian export**: a one-way mirror writes every note and transcript as Markdown with frontmatter into a folder of your choice
- **Audio import**: drag in audio or video files, batch uploads, or paste a YouTube or direct media URL
- **Local or LAN, per task**: dictation, meetings, uploads, cleanup, notes, chat, the assistant and translation each choose between an on-device model and a self-hosted endpoint
- **On-device engines**: whisper.cpp (Metal, CUDA, Vulkan), NVIDIA Parakeet, Nemotron, Cohere Transcribe and Orukeet via sherpa-onnx, and GGUF chat models (Qwen, Gemma, Llama, Mistral, GPT-OSS, LiquidAI) via llama.cpp
- **CLI bridge**: a loopback-only HTTP bridge on `127.0.0.1` for scripting a running app

## Quick start

```bash
git clone <this fork>
cd openwhispr
npm ci
npm run dev
```

Requires Node.js 24 (see `.nvmrc`). `npm run dev` downloads the bundled binaries (whisper.cpp, llama.cpp, sherpa-onnx, Qdrant, yt-dlp) on first run. Build installers with `npm run build:mac`, `npm run build:win`, or `npm run build:linux`; `npm run pack` makes an unsigned build.

On first launch, onboarding asks for permissions, languages and hotkeys, then whether to run **on this computer** (it downloads the models you pick) or on **your own server** (you enter the endpoint and test it).

## Using servers on your LAN

Any OpenAI-compatible server works: vLLM, llama.cpp server, Ollama, LocalAI, faster-whisper-server, and similar. Each task has its own endpoint, so speech-to-text and chat can live on different machines.

| Task                                         | Setting                                      | Endpoint used                                 | Example base URL         |
| -------------------------------------------- | -------------------------------------------- | --------------------------------------------- | ------------------------ |
| Dictation, meeting and upload transcription  | Settings → Transcription → Self-hosted       | `POST /audio/transcriptions`                  | `https://whisper.lan/v1` |
| Cleanup, notes, chat, assistant, translation | Settings → AI Models → (scope) → Self-hosted | `POST /chat/completions` (SSE), `GET /models` | `https://llm.lan/v1`     |

- An API key is optional. When set, it is sent as a bearer token and stored encrypted with a master key kept in the OS keychain
- Plain `http://` is allowed only for private addresses (`localhost`, RFC 1918, Tailscale, `*.local`, `*.ts.net`). Anything else, including names like `llm.lan`, needs HTTPS with a certificate your OS trusts
- Every endpoint field has a **Test connection** button
- Uploads larger than 25 MiB are split before sending. If the server supports `verbose_json`, segment timestamps are used to place speakers
- Meetings are sent as short audio batches, one request at a time, so a server that decodes one sequence at a time keeps up. When it falls behind, batches merge (at most 30 seconds of backlog is kept)
- For chat models, you can turn thinking, tool calling (needed for notes search and web search) and image input on or off per scope

Speaker diarization, embeddings and live dictation preview always run on-device.

## Web search with SearXNG

1. Enable JSON output in your instance's `settings.yml`:
   ```yaml
   search:
     formats:
       - html
       - json
   ```
2. In Settings → AI Models → Chat (or Voice Assistant) → Web search, turn it on and enter the instance URL, for example `https://search.lan`
3. Make sure tool calling is on for that scope

Only the search query and a time range are sent to SearXNG.

## Exporting to Obsidian

In Settings, open **Export to Markdown / Obsidian vault**, turn it on, and choose a folder inside your vault (for example `~/Obsidian/Vault/OpenWhispr`).

- Each note becomes `<title>.md`, and meetings and uploads also get a `<title> (transcript).md` linked by wikilinks
- Folders become subfolders. Notes that are not in a folder go to `Personal/`
- Frontmatter includes the type, dates, duration, participants, the linked calendar event, and tags under a base tag you choose (default `openwhispr`)
- Dictations can be appended to daily files under `Dictations/`
- The export only goes one way. It never touches files it did not write, and **Rebuild all files** rewrites everything

## Documentation

- [CLAUDE.md](CLAUDE.md): architecture and implementation reference
- [docs/network-allowlist.md](docs/network-allowlist.md): every host the app can contact
- [LOCAL_WHISPER_SETUP.md](LOCAL_WHISPER_SETUP.md): on-device Whisper models
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and [DEBUG.md](DEBUG.md): diagnostics
- [examples/custom-asr-shim](examples/custom-asr-shim/): adapter for ASR servers that are not OpenAI-compatible

The `openwhispr-mobile/` directory is upstream's mobile app. This fork has not changed it.

## Tech stack

React 19, TypeScript, Tailwind CSS v4, Electron 41, better-sqlite3, whisper.cpp, sherpa-onnx, llama.cpp, Qdrant, Vercel AI SDK, shadcn/ui

## License

[MIT](LICENSE).

## Acknowledgments

- **[OpenWhispr](https://github.com/OpenWhispr/openwhispr)**: the upstream project this fork is based on
- **[OpenAI Whisper](https://github.com/openai/whisper)** and **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)**: local speech recognition
- **[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** and **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)**: fast multilingual ASR and diarization
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)**: local LLM inference
- **[Qdrant](https://qdrant.tech/)**: local vector search
- **[SearXNG](https://github.com/searxng/searxng)**: self-hosted metasearch
- **[Electron](https://www.electronjs.org/)**, **[React](https://react.dev/)**, **[shadcn/ui](https://ui.shadcn.com/)**
