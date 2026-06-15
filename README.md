# Accio Switch

Accio Switch is a local Windows companion for routing supported Accio Work LLM traffic through an OpenAI-compatible endpoint while transparently proxying other Accio services to the official gateway.

## Run and build

```powershell
npm install
npm run electron:dev
```

Build the portable Windows executable:

```powershell
npm run electron:build
```

The packaged executable is written to `release/Accio-Switch-0.3.3.exe`.

## Current compatibility

- Accio Work 0.16.0 model-list injection
- OpenAI-compatible `/v1/models`
- Upstream model discovery through OpenAI-compatible `/v1/models`
- Separate upstream image-model discovery and validation
- Independent image model and image API key configuration
- NewAPI-compatible Images API requests without legacy `response_format`
- Static `latest.json` update checks for portable Windows builds
- OpenAI-compatible `/v1/chat/completions`
- Accio ADK SSE response frames
- JSON and SSE provider responses
- Text, image input, function declarations, and multi-turn tool results
- Tool argument validation with one focused repair retry
- Independent custom image endpoint, model, API key, and protocol
- Chat Completions image output and OpenAI Images API generation/editing
- No official LLM or image-model fallback in custom mode
- Large tool results compacted before upstream model calls
- One retry for transient third-party provider 5xx responses
- Transparent forwarding for non-LLM Accio API routes
- Optional fallback to the official Accio gateway
- API keys encrypted with Windows secure storage
- Launch guard that requires existing Accio Work processes to be closed first

Accio uses a private protocol. The current bridge emits the SSE frames required by the bundled Accio ADK SDK, but future desktop releases may require updates.

## Tauri source

The repository also contains a Tauri/Rust implementation under `src-tauri`. Electron is the current packaged runtime because the local Windows build environment could not complete the Rust dependency build with its available page file.
