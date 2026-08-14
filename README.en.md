<p align="center">
  <img src="assets/brand/freecoder-logo.png" alt="FreeCoder" width="128" height="128" />
</p>

<h1 align="center">FreeCoder</h1>

<p align="center">
  <strong>A cheap, easy desktop AI coding assistant</strong><br />
  Up to 100M free tokens · China-direct APIs · Or fully local with zero API cost
</p>

<p align="center">
  <a href="README.md">中文</a> · <b>English</b>
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D6?logo=windows&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" />
  <img alt="Free quota" src="https://img.shields.io/badge/Free_tokens-100M+-26E0C8" />
  <img alt="China" src="https://img.shields.io/badge/China_APIs-no_ban_worries-0F344B" />
</p>

---

## Why FreeCoder

**Cheap, easy, double-click to start.** The points that matter first:

| Advantage | What you get |
|-----------|----------------|
| **Up to 100 million free tokens** | Alibaba Cloud Bailian new-user campaign, claimed in-app (subject to official rules) |
| **Those tokens actually work** | **Coding, image-data cleanup, image generation, video generation** |
| **China-domestic model APIs** | Direct mainland endpoints — **no VPN, no overseas-ban anxiety** |
| **DeepSeek is tiny money** | A simple Flash job is about **¥0.12** |
| **Or run fully local** | Load a local model on your machine — **spend nothing on APIs** |

The free quota is from **domestic Chinese clouds** (Alibaba Qwen / Bailian), not an overseas account:

- **Write and patch code** — coding agent
- **Sort and understand images / screenshots** — multimodal / image-data work
- **Generate images** — e.g. Qwen Image
- **Generate video** — e.g. HappyHorse

Do not want the cloud at all? Turn on local inference. **Completely free.**

## What powers the agent

The coding engine is **xAI’s [Grok Build](https://github.com/xai-org/grok-build)** — the same generation of agents as [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Cursor](https://cursor.com), and [OpenAI Codex](https://openai.com/codex): plan, edit files, run commands, loop until done.

The desktop UI is **FreeCoder’s own frontend**. We localized it for China: **double-click install**, domestic models by default, engine capability on par with upstream — not a chat skin.

## Domestic APIs: network and account risk off the table

The main path is China-direct APIs. We do not make overseas vendors the onboarding story.

- **Alibaba Qwen (Bailian)** — free quota + pay-as-you-go. LLM, multimodal, image, and video, all in China.
- **DeepSeek** — official China endpoint, low price, stable latency. Use Flash for everyday tasks.

Connect them in Settings. No VPN-required workflow, and daily use is not tied to overseas accounts that get banned.

### Claim Alibaba free tokens in one step

Settings → **Get API Key**: sign in to Alibaba Cloud; FreeCoder helps create and fill in the Bailian key.

New users can claim **100 million+ free tokens** via the official campaign (Alibaba’s current rules win). One key covers coding, multimodal, image, and video. Alibaba grants the quota; FreeCoder makes it usable immediately.

### DeepSeek: about ¥0.12 per simple task

From the official [Models & pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) page, **CNY per million tokens**:

| Model | Input (cache hit) | Input (cache miss) | Output |
|-------|-------------------|--------------------|--------|
| **deepseek-v4-flash** | ¥0.02 | **¥1** | **¥2** |
| deepseek-v4-pro | ¥0.025 | ¥3 | ¥6 |

Use **Flash** for small edits (bugfix, helper function, a short read). One pass is usually **under 100k tokens**. Conservative estimate, **no cache hits**:

| Item | Tokens | Unit price | Cost |
|------|------:|------------|-----:|
| Input | 80,000 | ¥1 / million | **¥0.08** |
| Output | 20,000 | ¥2 / million | **¥0.04** |
| **Total** | 100,000 | | **¥0.12** |

> **A simple coding task is about twelve cents (CNY).** ¥1 ≈ 8 tasks; ¥10 ≈ 80.  
> This is a high estimate: cache hits drop input to ¥0.02 / million. Use Pro for long jobs.

Prices follow the official page at the time you use it.

## Fully local: zero API spend

FreeCoder **can load and run a local model on your machine**. No cloud, no API key, still coding.

- **Free** — not billed per token
- **Private** — source stays on the PC
- **Offline** — no international network required

Use the cloud when you want stronger models, image/video, or the free quota. Everyday coding can stay local and **cost nothing on APIs**.

## How to use

**Double-click the installer.** No toolchain, no engine compile.

- Free quota: claim Bailian in Settings → coding / image cleanup / image / video
- Cheaper domestic coding: DeepSeek Flash
- Zero cost: local inference

Permission modes: ask / auto / full trust. Tasks can keep running in the background.

## Run from source

This repository publishes the **desktop frontend** (Tauri 2 + React + Rust) plus a callable `media-mcp.exe`. It does not include engine source or cloud secrets.

```powershell
cd frontend\apps\desktop
pnpm install
pnpm tauri dev
```

Windows 10/11 x64, Rust stable, Node.js 20+, pnpm, WebView2. Local inference: NVIDIA GPU (CUDA 12+) recommended. Keep API keys in local Settings.

## License

Product code [Apache-2.0](LICENSE). Agent engine upstream: [Grok Build](https://github.com/xai-org/grok-build) (Apache-2.0, see [NOTICE](NOTICE)).

FreeCoder is not an xAI product. Claude Code, Cursor, and Codex belong to their owners. Bailian quota and DeepSeek prices follow [Alibaba Cloud](https://bailian.console.aliyun.com) and the [DeepSeek tariff](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/).
