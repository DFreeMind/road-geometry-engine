# 开发、构建与验证

所有根目录命令从仓库根目录执行。Windows 开发需要 Rust stable/MSVC、C++ Build Tools、Node.js 22.12+、pnpm 11，以及可用的 GDAL/PROJ 构建来源。生产程序需要 WebView2 和随包 GIS 资源，不需要 Node.js、Python 或 QGIS 界面。

## 构建与启动

```powershell
# GisRoot 是本机包含 GDAL 工具与数据的构建来源，按实际路径填写。
.\scripts\build-maplibre.ps1 -GisRoot 'C:\Program Files\QGIS 3.44.8'
.\launch.ps1

# 优化版本
.\scripts\build-maplibre.ps1 -GisRoot 'C:\Program Files\QGIS 3.44.8' -Release
.\launch.ps1 -Release
```

构建脚本准备资源、编译唯一 Rust 引擎和 Tauri 客户端，再生成独立部署目录。`start.cmd` 默认启动已有调试部署；找不到程序时才构建。修改代码后需要主动重新构建，启动入口不会检查源码是否比部署更新。

前端开发与 Tauri 开发入口：

```powershell
.\scripts\prepare-maplibre.ps1 -GisRoot 'C:\Program Files\QGIS 3.44.8'
cd desktop-tauri
pnpm install --frozen-lockfile
pnpm tauri dev
```

单独 `pnpm dev` 仅启动 Vite，完整本地命令需要 Tauri 容器。共享服务与桌面适配是不同 Cargo 工程；不要只检查根目录引擎后宣称全项目通过。

## 验证入口

```powershell
# 三套 Rust 工程的 fmt/test/Clippy，以及前端格式、测试与构建
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1
# 另加已有 Tauri 部署的自动桌面回归
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1 -DesktopSmoke
# 可选：外部 QGIS/GEOS 独立几何校验及 Python 设施资源校验
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1 -IndependentGis
```

`-DesktopSmoke` 使用现有部署和独立 WebView2 数据目录，报告输出到 `artifacts/maplibre-qa/`，不会重新构建程序。若代码行为有变化，先构建再运行。脚本混合控件交互与程序化状态/命令检查，结果只覆盖报告中的项目，不等同于全量人工界面验收。真实数据库、线上底图和跨设备性能需要对应环境单独验证。

凭据实机检查使用 `scripts/validate-credentials.ps1`，在独立配置中处理合成凭据。常规服务测试中被忽略的系统凭据测试不能写成已通过。

PowerShell 启动链中的中文 `.ps1` 保存为 UTF-8 BOM，并用 Windows PowerShell 5.1 解析和运行。版本锁位于根目录、`desktop-service/`、`desktop-tauri/src-tauri/` 的 Cargo.lock 及 `desktop-tauri/pnpm-lock.yaml`；不要在整理时顺带升级依赖。

## 工程与成果保护

测试使用 `fixtures/` 与生成的合成数据。运行程序、报告、缓存与导出文件不提交 Git，连接凭据和用户原始数据也不提交。每轮明确改进验证后创建中文提交，不自动推送。磁盘清理规则见 [工作目录与磁盘空间](workspace-storage.md)。
