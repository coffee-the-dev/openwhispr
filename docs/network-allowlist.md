# Network Allowlist

Every outbound host this local-only fork of OpenWhispr can contact at runtime.
For firewall, proxy, and DNS filter configuration.

There is no account, cloud API, telemetry upload, or auto-updater. A fresh
install with on-device models already downloaded makes no outbound connection
on its own. Everything below is either a server you configure yourself, a
download you start, or a link you click. No inbound ports are opened; the only
listeners bind to `127.0.0.1` (local model servers, Qdrant, the CLI bridge).

## Servers you configure (your LAN)

Contacted only when you enter the URL in Settings. The app talks to exactly the
host you type, over HTTP or HTTPS, and sends a bearer key only when you set one.

| Setting                                                   | Example                  | Protocol    | Purpose                                                                                                    |
| --------------------------------------------------------- | ------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------- |
| Transcription → Self-hosted endpoint                      | `https://whisper.lan/v1` | HTTP, HTTPS | OpenAI-compatible `/audio/transcriptions` and `/models` for dictation, meeting chunks, and uploaded files. |
| Transcription → Speaker detection engine → Self-hosted    | `https://speech.lan/v1`  | HTTP, HTTPS | `POST /audio/diarizations` (NeMo-Speech.cpp) for meeting and upload speaker detection.                     |
| AI Models → Self-hosted endpoint (every scope)            | `https://llm.lan/v1`     | HTTP, HTTPS | OpenAI-compatible `/chat/completions` (SSE) and `/models` for cleanup, the assistant, notes, and chat.     |
| AI Models → Web search → SearXNG URL                      | `https://search.lan`     | HTTP, HTTPS | `GET /search?format=json` for the assistant's web search tool.                                             |

`localhost` and `127.0.0.1` also work for all of them.

## Downloads you start

| Host                                                                                  | Protocol | Port | When                                                                                                       |
| ------------------------------------------------------------------------------------- | -------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `huggingface.co` and its file CDNs (`*.huggingface.co`, `*.hf.co`)                    | HTTPS    | 443  | Downloading a Whisper, Orukeet, or GGUF model; the embedding model on the first semantic search.           |
| `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | HTTPS    | 443  | Downloading a Parakeet, Nemotron, or Cohere model or the diarization models (sherpa-onnx releases).        |
| `api.github.com` (plus the GitHub download hosts above)                               | HTTPS    | 443  | Installing a GPU acceleration pack (CUDA/Vulkan whisper.cpp, Vulkan llama.cpp) from GitHub releases.       |
| `www.youtube.com`, `youtube.com`, `youtu.be`, `m.youtube.com`, `music.youtube.com`    | HTTPS    | 443  | Pasting a YouTube link into the Upload view (bundled yt-dlp).                                              |
| `*.googlevideo.com`                                                                   | HTTPS    | 443  | YouTube media CDN for the same import.                                                                     |
| _User-pasted hosts_                                                                   | HTTPS    | 443  | Direct audio/video URL imports. HTTPS only; hosts resolving to private or internal addresses are rejected. |

## Loaded while you use the app

| Host               | Protocol | Port | When                                                                                               |
| ------------------ | -------- | ---- | -------------------------------------------------------------------------------------------------- |
| `www.gravatar.com` | HTTPS    | 443  | Avatar images for meeting participants with an email address (an MD5 hash of the address is sent). |

## Links you click

Opened in your browser, never fetched by the app: `docs.openwhispr.com`,
`github.com`, `discord.gg`, and `mail.google.com` (Support menu), plus the
download pages linked from Linux paste-tool help.

## Build time only

`npm run dev` / `npm run build` download bundled binaries (whisper.cpp,
llama.cpp, sherpa-onnx, Qdrant, yt-dlp, the Windows helpers) from
`github.com` / `objects.githubusercontent.com`, models from `huggingface.co`,
and `nircmd` from `www.nirsoft.net`. None of this happens in a packaged app.

## Notes

- The app uses Electron's network stack, which honors system proxy settings
  and PAC scripts on all platforms.
- A self-hosted HTTPS endpoint needs a certificate the OS trusts. On minimal
  Linux installs without a system CA bundle, set `NODE_EXTRA_CA_CERTS`.
- Blocking every host above leaves dictation, meeting transcription,
  on-device reasoning, notes, and search working with the models already on
  disk.

## How to test

```sh
# Your LAN endpoints
curl -v https://whisper.lan/v1/models -H "Authorization: Bearer $KEY"
curl -v https://llm.lan/v1/models
curl -v "https://search.lan/search?q=test&format=json"

# Model downloads
curl -v -I https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
```
