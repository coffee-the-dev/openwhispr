# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.10.x  | :white_check_mark: |
| < 1.10  | :x:                |

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/OpenWhispr/openwhispr/security/advisories/new)
to submit a report. You can also email security@openwhispr.com.

We will acknowledge your report within **48 hours** and aim to release a fix
within **7 days** for critical issues.

## Scope

The following are in scope:

- Remote code execution via crafted audio files or transcription output
- Privilege escalation through native binaries (key listeners, paste helpers)
- Credential exposure (self-hosted endpoint API keys, database contents)
- Cross-site scripting (XSS) in the Electron renderer
- Insecure IPC between main and renderer processes
- Supply chain attacks via dependencies or native compilation

Out of scope:

- Issues requiring physical access to an already-unlocked machine
- Denial of service against the local application
- Social engineering

## Security Model

- **Local and LAN only** — This fork has no account, cloud API, third-party
  AI providers, telemetry upload, or auto-updater. Audio and text are
  processed on-device (whisper.cpp, sherpa-onnx, llama.cpp) or sent only to
  OpenAI-compatible servers and a SearXNG instance the user configures. The
  complete list of hosts the app can contact is in
  [docs/network-allowlist.md](docs/network-allowlist.md).
- **Endpoint transport** — Self-hosted endpoints must use HTTPS unless the
  host is private (loopback, RFC 1918 / CGNAT / link-local addresses,
  `*.local`, `*.ts.net`). URL audio import is HTTPS-only and refuses hosts
  that resolve to private addresses.
- **Credential storage** — The only secrets are optional bearer keys for
  self-hosted endpoints. Each is AES-256-GCM encrypted under
  `userData/secure-keys/` with a master key held in the OS keychain (via
  `@napi-rs/keyring`, with Electron `safeStorage` as fallback). Non-secret
  preferences (endpoints, hotkeys, flags) live in `.env` and localStorage.
- **Native binaries** — Platform-specific helpers (key listeners, paste
  utilities) are compiled from source during the build process.
- **Context isolation** — The Electron renderer runs with context isolation
  enabled and a restricted preload bridge.

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will credit
reporters in the changelog (unless they prefer to remain anonymous).
