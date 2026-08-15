<p align="center">
  <img src="assets/brand/freecoder-logo.png" alt="FreeCoder" width="128" height="128" />
</p>

<h1 align="center">FreeCoder</h1>

<p align="center">
  <strong>廉价、好用的桌面 AI 编程助手</strong><br />
  最高 1 亿免费 Token · 国内模型直连 · 也可完全本地、零 API 费用
</p>

<p align="center">
  <b>中文</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D6?logo=windows&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" />
  <img alt="Free quota" src="https://img.shields.io/badge/Free_tokens-100M+-26E0C8" />
  <img alt="China" src="https://img.shields.io/badge/国内直连-不担心封号-0F344B" />
</p>

---

## 核心优势

**廉价、好用，双击就能上手。** 下面这些是 FreeCoder 要先讲清楚的：

| 优势 | 你实际得到什么 |
|------|----------------|
| **最高 1 亿免费 Token** | 阿里云百炼新用户活动，应用内协助领取（以官方规则为准） |
| **免费额度能干活** | **编程任务、图像数据整理、生成图片、生成视频** |
| **全是国内模型 API** | 国内直连，**不用担心网络，也不用担心封号** |
| **DeepSeek 也极便宜** | 简单任务用 Flash，一次大约 **0.12 元**（不到一毛五） |
| **也可以完全本地跑** | 本机加载本地模型推理，**API 上一分钱不用花** |

这些免费 Token 来自**国内云厂商**（阿里通义千问 / 百炼），不是海外账号：

- **写代码、改仓库、跑命令** —— 编程 Agent
- **整理、理解图片和截图** —— 多模态 / 图像数据整理
- **生成图片** —— 如 Qwen Image
- **生成视频** —— 如 HappyHorse

不想走云、不想花 API 钱：打开本地推理即可，**完全免费**。

## 后端是谁做的

编码引擎来自 **xAI 的 [Grok Build](https://github.com/xai-org/grok-build)**，和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）、[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Cursor](https://cursor.com)、[OpenAI Codex](https://openai.com/codex) 同属一代 Agent：规划、改文件、执行命令、循环直到做完。

桌面是 **FreeCoder 自己的前端**。我们做了国产化适配：**双击安装就能用**，默认走国内模型，引擎能力与上游一致，不是换一套「套皮聊天」。

## 国内模型，不用翻墙、不用担心封号

主路径就是国内 API，不为海外厂商准备使用门槛。

- **阿里通义千问（百炼）**：免费额度 + 按量。语言模型、多模态、生图、生视频都在国内。
- **DeepSeek**：国内官方接口，价格低、延迟稳。日常小任务用 Flash 即可。

设置里一键接入。不依赖必须翻墙的工作流，也不把日常使用绑在容易封号的海外账号上。

### 一键领取阿里免费 Token

设置 → **获取 API Key**：登录阿里云后，协助创建并回填百炼密钥。

新用户通过官方活动，**最高可领 1 亿 Token 以上**免费额度（以阿里云当时规则为准）。同一把 Key 覆盖编程、多模态、生图、生视频。额度由阿里云发放，FreeCoder 负责接到就能用。

### DeepSeek：简单任务大约一毛二

价格见官方 [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，单位：元 / 百万 tokens。

| 模型 | 输入（缓存命中） | 输入（未命中） | 输出 |
|------|------------------|----------------|------|
| **deepseek-v4-flash** | 0.02 元 | **1 元** | **2 元** |
| deepseek-v4-pro | 0.025 元 | 3 元 | 6 元 |

小改动用 **Flash**（修 bug、补函数、看一小段代码），一轮通常 **不到 10 万 token**。按缓存全未命中的保守估：

| 项目 | Token | 单价 | 费用 |
|------|------:|------|------:|
| 输入 | 80,000 | 1 元 / 百万 | **0.08 元** |
| 输出 | 20,000 | 2 元 / 百万 | **0.04 元** |
| **合计** | 100,000 | | **0.12 元** |

> **一次简单编程任务约一毛二。** 一块钱大约 8 次；充 10 元大约 80 次。  
> 这还是高估：缓存命中后输入可降到 0.02 元 / 百万。长任务再换 Pro。

价格以官网当时标价为准。

## 完全本地：API 零费用

FreeCoder **支持在本机加载并运行本地模型**。不连云、不申请 Key，也可以完成编程任务。

- **完全免费**：不按 token 计费
- **数据不出电脑**：源码留在本机
- **断网也能用**：不依赖国际网络

云端适合要更强模型、要生图生视频、要花免费额度的时候；日常编码可以全程本地，**API 一分钱不用花**。

## 怎么用

**双击安装包即可。** 不用先装开发环境，也不用自己编译引擎。

- 要免费额度：设置里领阿里百炼 Key，即可编程 / 理图 / 生图 / 生视频
- 要更便宜的国内编程：接 DeepSeek Flash
- 要零成本：开本地模型推理

权限可调（需审批 / 自动 / 完全信任），多任务可在后台继续跑。

## 许可证

产品代码 [Apache-2.0](LICENSE)。Agent 引擎上游为 [Grok Build](https://github.com/xai-org/grok-build)（Apache-2.0，见 [NOTICE](NOTICE)）。

FreeCoder 不是 xAI 官方产品。Claude Code、Cursor、Codex 为各自权利人的产品。阿里云百炼免费额度、DeepSeek 价格分别以 [阿里云](https://bailian.console.aliyun.com) 与 [DeepSeek 价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 为准。
