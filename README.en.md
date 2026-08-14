<p align="center">
  <img src="assets/brand/freecoder-logo.png" alt="FreeCoder" width="128" height="128" />
</p>

<h1 align="center">FreeCoder</h1>

<p align="center">
  <strong>A desktop coding agent that can run fully free and fully offline</strong><br />
  Powered by xAI Grok Build · Localized for users in China
</p>

<p align="center">
  <a href="README.md">中文</a> · <b>English</b>
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D6?logo=windows&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" />
  <img alt="Local" src="https://img.shields.io/badge/Local-Free-26E0C8" />
  <img alt="China" src="https://img.shields.io/badge/China-Ready-0F344B" />
</p>

---

FreeCoder is a desktop AI coding agent. It edits your repo, runs commands, and manages tasks through a real agent engine—not a chat overlay.

Install with a double-click. Run a **local model at zero cost**, or connect **DeepSeek** and **Alibaba Qwen** in one step. International models such as xAI Grok remain optional.

## Relationship with Grok

The **agent backend is xAI’s [Grok Build](https://github.com/xai-org/grok-build)**.

That places FreeCoder on the same generation of coding agents as [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Cursor](https://cursor.com), and [OpenAI Codex](https://openai.com/codex): an engine that plans, patches files, runs tools, and loops until the task is done. Grok Build is xAI’s implementation of that stack.

The desktop shell evolved from the open-source [Grokx](https://github.com/tangf-ai/grokx) project. FreeCoder adds a full localization layer for China:

| Upstream | What FreeCoder adds |
|----------|---------------------|
| xAI Grok Build | Same agent engine — **coding performance stays on par with upstream** |
| Grokx desktop | Installer, models, networking, and permissions adapted for local use |
| Local / China clouds | Can work without any international API |

**In short:** xAI-grade agent technology underneath; a double-click Chinese desktop product on top. Not a reskin, and not a swapped-out engine.

## Completely free, if you want it

Pick the bundled local model after install. **No API key. No cloud bill.**

The default local model is **Bonsai 27B (1-bit)**, running on your NVIDIA GPU (CUDA 12+). Source never leaves the machine. Coding still works with the network unplugged.

### Why run locally

- **Zero cost** — no per-token fees, even on long, large-repo sessions
- **Data stays on device** — source, secrets, and internal docs never go to a vendor
- **Offline capable** — no VPN, no overseas endpoint required
- **Stable latency** — no queue, no cloud rate limits
- **Simpler compliance** — a better default when code must not leave the building

Use the cloud when you need stronger reasoning or image/video generation. Day-to-day coding can stay local and free.

## Built to work in China

Networking and vendors are adapted for mainland China. You do not need an overseas-only workflow.

| Mode | Cost | Network | Typical use |
|------|------|---------|-------------|
| **Local Bonsai** | Free | Offline OK | Coding, vision, private repos |
| **DeepSeek** | Low domestic price | Direct in China | Strong coding (V4 Flash / Pro) |
| **Alibaba Qwen** | Free quota + pay-as-you-go | Direct in China | LLM, multimodal, image, video |
| xAI Grok, etc. | Usage-based | Depends on your network | Optional |

DeepSeek uses the official China endpoint: inexpensive, low latency, a solid cloud default beside local inference.  
Qwen runs through Alibaba Cloud Bailian: text, vision, image generation, and video generation in the same desktop app.

## Claim Alibaba Qwen free tokens

Settings includes **Get API Key**. After you sign in to Alibaba Cloud, FreeCoder helps create a Bailian key and fills it in, so Qwen-family models can be activated.

New users can claim **Alibaba Cloud Bailian promotional quota—often 100 million tokens or more** (subject to Alibaba’s current campaign). One key covers:

- **Language models** — e.g. Qwen 3.7 Plus / Max / Flash
- **Multimodal models** — screenshots and images
- **Image generation** — Qwen Image
- **Video generation** — HappyHorse and related models

In-app links open the official free-quota pages for each model. Tokens are granted by Alibaba Cloud; FreeCoder only connects those models so they work immediately.

## Experience

For end users: **double-click the installer and start coding**. Runtime, engine, and local model are bundled—no Rust/Node toolchain, no manual Grok Build compile.

- Local free model is ready after install
- Add DeepSeek or Alibaba Bailian in Settings for domestic cloud models
- Permission modes: ask every time / auto / full trust
- Multi-task: background work continues when you switch
- Image/video generation uses Bailian media by default; files land in the local task folder

To build the desktop frontend from this repository, see below.

## Run from source

This repository publishes the **desktop frontend** (Tauri 2 + React + Rust crates) plus a callable `media-mcp.exe`. It does not include the engine source tree or cloud secrets.

```powershell
cd frontend\apps\desktop
pnpm install
pnpm tauri dev
```

Requires Windows 10/11 x64, Rust stable, Node.js 20+, pnpm, and WebView2. Local inference needs an NVIDIA GPU (CUDA 12+, 8 GB VRAM recommended).

Keep API keys in local Settings. Never commit them.

## License and credits

- Product code: [Apache-2.0](LICENSE)
- Agent engine upstream: [Grok Build](https://github.com/xai-org/grok-build) (Apache-2.0, see [NOTICE](NOTICE))
- Desktop shell upstream: [Grokx](https://github.com/tangf-ai/grokx)

FreeCoder is not an xAI product. Grok and Grok Build are trademarks or project names of xAI. Claude Code, Cursor, and Codex belong to their respective owners. Alibaba Cloud Bailian free quota is governed by Alibaba Cloud’s official terms.
