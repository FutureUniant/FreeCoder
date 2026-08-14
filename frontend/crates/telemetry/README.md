# telemetry

开源仓库中的**空实现**：`init` / `on_event` 什么都不发。

官方安装包若在本机发现未开源的统计覆盖实现，会在打包时临时替换本 crate，编完再还原。开源克隆与 `pnpm tauri dev` 不会上报。
