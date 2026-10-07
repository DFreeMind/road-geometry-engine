# 路境 · 道路几何工作台

客户端采用 **Tauri 2 + React/TypeScript + MapLibre GL JS + Rust**。Windows 使用 WebView2；只维护一个客户端和一个 Rust 道路业务引擎。计算使用投影米制坐标，地图显示和地理 GeoJSON 使用 WGS84，GeoPackage 导出保留工程 CRS。

## 启动与构建

Windows 双击 `start.cmd`，或从仓库根目录执行：

```powershell
.\launch.ps1
```

入口启动已有调试部署。首次开发构建需要 Rust stable/MSVC、C++ Build Tools、Node.js 22.12+、pnpm 11，以及可用的 GDAL/PROJ 构建来源：

```powershell
.\scripts\build-maplibre.ps1 -GisRoot 'C:\Program Files\QGIS 3.44.8'
# 优化构建与启动
.\scripts\build-maplibre.ps1 -GisRoot 'C:\Program Files\QGIS 3.44.8' -Release
.\launch.ps1 -Release
```

当前准备脚本可从已安装 QGIS 提取 GDAL 工具与数据；生产程序不调用 QGIS、Qt 或 Python。程序与运行资源位于 `artifacts/maplibre-desktop/debug/` 或 `release/` 下的独立构建目录，`current-build.txt` 指向当前部署。修改代码后需重新构建并重新打开程序。删除整个 `artifacts` 会删除当前可运行程序，下一次启动需要重新构建。

## 工作台

- 导入本地矢量或连接来源、分页选择路线，保留完整字段及多部件几何；也可人工绘制和编辑参考线。
- 左右独立配置逐车道宽度、中央隔离带、应急车道、路肩及边坡水平投影；支持字段映射和来源默认断面。
- 单路线或已加载的参与路线分块生成，提供进度、取消、输入版本校验和可定位的生成问题。
- 道路部件宽度与顶点编辑、删除恢复、撤销重做；人工设施独立于道路重生成。
- 12 类、66 个基础设施子类型，模板与实例快照分开；支持人工布设及基础沿线参数化示意布设。
- MapLibre 底图和图层管理，本地定位影像按视口生成瓦片并使用有界缓存；在线服务按用户选择请求。
- schema 2 JSON 工程保存恢复、schema 1 兼容、WGS84 GeoJSON 和工程 CRS GeoPackage 导出；未保存编辑提供保存、放弃和取消。

分页传输大小不是总量上限，支持分页的来源可续读到末页；有界快照来源明确提示未完整状态。每条路线仍采用固定横断面，区间变宽、断链、复杂路口、真实三维、影像配准和 AI 提取尚待完善。矢量及成果仍驻留工程和地图内存中，自动回归不能证明百万复杂面或超大影像的生产性能。完整范围见 [工作台能力](docs/workbench-capabilities.md)。

## 代码组织

| 目录 | 职责 |
| --- | --- |
| `src/` | 唯一 Rust 道路几何引擎与沿线规则 |
| `desktop-service/` | 共享 Rust 业务服务：GIS、生成调度、工程与凭据 |
| `desktop-tauri/` | React/TypeScript 工作台和 Tauri Rust 适配 |
| `tools/facility-assets/` | 无界面的设施目录、符号工具及 SVG 源资源 |
| `scripts/`、`tests/`、`fixtures/` | 构建、验证及合成样本 |
| `docs/` | 当前说明、专题规则和有日期的验收证据 |

## 验证与文档

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1
# 另加已有 Tauri 部署的自动桌面回归
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1 -DesktopSmoke
```

基础验证覆盖三套 Rust 工程的格式、测试、Clippy，以及前端格式、测试和生产构建。桌面回归使用独立 WebView2 配置，不关闭用户已有窗口；若运行逻辑改变，先构建再验证。API 调用及程序化状态检查不替代全量人工界面验收。

开发与部署见 [开发指南](docs/development.md)，模块和坐标边界见 [架构](docs/architecture.md)，完整专题入口见 [文档导航](docs/README.md)。Qt 与旧 PyQGIS 客户端已删除，路线恢复及当轮验证记录见 [技术路线记录](docs/tauri-route-restoration-20261007.md)。
