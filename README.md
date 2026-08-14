# FreeCoder

可本地运行的桌面 AI 编程助手前端（Tauri 2 + React + Rust workspace）。

本仓库只包含前端代码，以及可调用的 `media-mcp.exe`（百炼图像/视频 MCP）。不包含后端引擎、云端部署配置，也不包含任何 API Key。

## 目录

```text
frontend/
  apps/desktop/     # Tauri 桌面应用
  crates/           # 产品侧 Rust crates
frontend/apps/desktop/src-tauri/resources/runtime/media-mcp.exe
```

## 快速开始（Windows）

```powershell
cd frontend\apps\desktop
pnpm install
pnpm tauri dev
```

需要：Windows 10/11 x64、Rust stable、Node.js 20+、pnpm、WebView2。

API Key 请在应用设置中配置，保存在本机，不要写入仓库。

## 许可证

Apache-2.0（见 `LICENSE`）
