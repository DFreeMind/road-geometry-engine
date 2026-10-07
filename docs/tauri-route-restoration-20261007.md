# 恢复 Tauri 技术路线

2026-10-07 用户决定停止 Qt 迁移，继续使用 Tauri 2 + React/TypeScript + MapLibre GL JS + Rust。

- 删除 `desktop-qt/`、Qt 专用启动、准备、构建、验证脚本和迁移文档。
- 删除旧 PyQGIS 客户端及专用界面测试；当轮 `desktop/` 仅保留无界面的设施目录、符号生成模块和 SVG 资源；后续整理已迁到 `tools/facility-assets/`，供 Tauri 构建使用。
- 保留唯一 Rust 引擎及 Tauri 实际依赖的 `desktop-service` 库，删除 Qt 专用的 JSON 服务可执行入口。共享服务内的数据读写、投影、项目、批量生成和凭据能力继续使用。
- 独立 GIS 包锁迁到 `scripts/gis-packages-win64.lock`；启动入口 `start.cmd` 与 `launch.ps1` 只启动 Tauri。
- 更新项目规则和验证脚本。旧界面设计、调研及历史审计文档标记为历史记录，不能作为当前实现说明。

验证入口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1 -DesktopSmoke
# 可选的外部 GIS/GEOS 几何校验及设施资源检查
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1 -IndependentGis
```

PowerShell 启动链中的改动脚本保存为 UTF-8 BOM，并使用 Windows PowerShell 5.1 检查解析。

本轮结果：核心 Rust 测试 27 项、共享服务 58 项、Tauri 后端 2 项通过；凭据实机测试 1 项仍按既有规则忽略。三套 Rust 工程 fmt/Clippy 通过，前端 139 项测试及 TypeScript/Vite 构建通过，改动脚本通过 Windows PowerShell 5.1.26100.9549 解析。

既有 Tauri 部署 `artifacts/maplibre-desktop/debug/build-20261005-071641-113/lujing-desktop.exe` 的自动桌面回归 102 项通过，浏览器错误 0，报告位于 `artifacts/maplibre-qa/20261007-103948-165/report.json`。其中合成 10,001 条碎路线完成全量分页读取、40 块生成及加载地图；本轮未使用用户原始数据，也未进行全量人工界面验收。独立 GIS 校验可选项本轮未执行。

Qt SDK、MapLibre Native for Qt 源码及构建/部署缓存原位于被 Git 忽略的 `artifacts/`。路线恢复当轮删除尝试被自动审批拦截，包括核对路径与链接后按明确路径删除的尝试；工具只返回 `blocked by policy`，未提供更具体原因。后续 2026-10-07 目录复查时，这些 Qt 缓存已不存在，`artifacts/` 仅剩 Tauri 部署；当前残留目录及清理状态见 [工作目录](workspace-storage.md)。
