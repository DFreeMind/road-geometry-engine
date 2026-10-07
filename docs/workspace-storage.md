# 工作目录与磁盘空间

`artifacts/` 被 Git 忽略，但不全是可随时丢弃的缓存。

## 目录职责

源码目录为 `src/`、`desktop-service/`、`desktop-tauri/`；配套目录为 `tools/`、`scripts/`、`tests/`、`fixtures/`、`docs/`。这些目录各自承担引擎、服务、客户端、资源工具、构建验证、样本及文档职责，保留独立模块边界。

`target/`、各 Rust 工程的 `target/`、前端 `dist/` 与 `node_modules/` 是可重建的开发产物，不是另一套客户端。它们按工具约定存放并由 Git 忽略；保留可以减少下一次构建耗时。

2026-10-07 最新目录检查时，`artifacts/` 只剩 `maplibre-desktop/`，此前 Qt SDK 和验证目录已不存在。下表仍说明准备或验证脚本可能重新生成的目录，不能据此推断这些目录当前都存在。

| 位置 | 内容 | 清理影响 |
| --- | --- | --- |
| `artifacts/maplibre-desktop/` | Tauri 当前与备用部署、程序、GIS 运行资源、版本指针 | 删除后不能直接启动，必须重新构建 |
| `artifacts/maplibre-qa/` 等验证目录 | 合成导出、截图、报告、独立 WebView2 配置 | 可清理；对应历史验收证据随之丢失 |
| `artifacts/fixtures/` | 自动验证生成的合成样本 | 可重新生成；先确认未混入需要保留的手工数据 |
| `artifacts/qt-*`、`maplibre-native-qt*` | 已退役 Qt 路线的 SDK、源码及构建缓存 | 当前构建和启动不再引用，可在确认无人使用后清理 |
| `artifacts/gis-sdk/`、`native-gis-*`、`micromamba-root/` | 独立 GIS 准备工具、依赖与缓存 | 删除后相应准备流程需重新下载或指定本地来源 |
| 根目录及各 Rust 工程的 `target/` | 编译缓存 | 删除后需重新编译，不能同时运行相关构建 |
| `desktop-tauri/dist/`、`node_modules/` | 前端构建与依赖 | 下次构建需重新生成或安装 |

任何手动保存到这些目录的工程、原始数据或需保留的导出应先移走。停止应用、构建和验证任务后再清理；不要删除正在运行程序所用的资源。

## 历史部署清理

```powershell
powershell.exe -NoProfile -File scripts/clean-desktop-builds.ps1 -WhatIf
powershell.exe -NoProfile -File scripts/clean-desktop-builds.ps1
```

构建完成后自动保留每个配置的当前版本、一个备用版本和正在运行的版本。清理脚本只删除符合命名规则的历史部署，当前指针无效、程序缺失或目录含链接时停止。它不清理 SDK、用户数据或验收报告。

## 全部删除后的恢复

源码和锁文件保留在 Git 中，删除 `artifacts` 不删除代码，但会删除当前部署与历史证据。重新构建需要完整开发环境，以及仍可使用的 GDAL/PROJ 构建来源：

```powershell
.\scripts\build-maplibre.ps1 -GisRoot 'C:\Program Files\QGIS 3.44.8'
.\launch.ps1
```

构建来源路径按实际环境填写。正常启动优先保留 `maplibre-desktop/`；无需为了清理旧 Qt 缓存重新编译 Tauri。

## 已确认可删除的旧目录残留

2026-10-07 目录复查确认：

- `desktop/` 没有受 Git 跟踪的文件，只剩旧 PyQGIS 模块的 `__pycache__` 和资源迁移后的空 `assets/` 子目录；当前代码、构建及测试均不再引用它。
- `output/` 只包含 `playwright/tauri-reference-basemap.png` 和 `tauri-reference-data.png` 两张旧 UI 参考截图，没有工程或用户原始数据；删除会丢失这两张历史截图。
- 根目录 `symbology-style.db` 是已退役 QGIS 环境的生成文件，已被 Git 忽略，当前 Tauri 路径不使用它。

本次自动清理被工具审批拒绝，递归删除及随后缩小到已核实文件和空目录的非递归删除均返回 `blocked by policy`，没有更具体原因；上述残留仍待删除。未将清理成功写成已完成事项。
