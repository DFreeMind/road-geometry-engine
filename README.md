# 路境 · 道路几何工作台

客户端采用 **Tauri 2 + React/TypeScript + MapLibre GL JS + Rust**。MapLibre 显示 WGS84 地理副本，项目与道路生成保留投影米制坐标；原有 Rust 几何引擎继续使用，GDAL/PROJ 适配本地矢量、影像与 GeoPackage。

## 启动

Windows 下双击 `start.cmd`，或执行：

```powershell
.\launch.ps1
```

默认启动新的 MapLibre 工作台。首次开发构建需要 Rust stable/MSVC、C++ Build Tools、Node.js 22.12+、pnpm 11，以及包含 GDAL 命令行和 PROJ 数据的构建来源。构建脚本可从已安装 QGIS 中提取 GDAL 运行资源；**构建后的程序不调用 QGIS、Qt 或 Python**，Windows 仍需 WebView2。当前默认构建调试版本；正式优化构建用 `-Release`。

```powershell
.\scripts\build-maplibre.ps1 -GisRoot 'C:\Program Files\QGIS 3.44.8'
.\launch.ps1 -Foreground
# 优化构建
.\scripts\build-maplibre.ps1 -Release
.\launch.ps1 -Release
```

程序及资源位于 `artifacts/maplibre-desktop/debug/build-时间戳/` 或 `release/build-时间戳/`，`current-build.txt` 指向最近完成的构建。构建不会覆盖正在运行的版本；启动脚本使用已构建版本，修改客户端后需重新运行构建脚本并重新打开程序。

旧 Qt/PyQGIS 客户端保留为迁移期参考：

```powershell
.\launch.ps1 -LegacyQgis
```

旧版完整使用说明见 [旧 QGIS 客户端](docs/legacy-qgis-client.md)。新旧客户端共用同一个 Rust 引擎。

## 工作台

- 标准菜单提供文件、编辑、数据、道路、视图和帮助命令；常用操作保留工具栏与快捷键。
- 中间画布使用 MapLibre WebGL，浮层提供绘制、顶点编辑、适配范围、底图、图例和倾斜视图；下部状态栏集中显示当前工具、坐标、比例及任务状态。
- 导入本地 GeoJSON/SHP/GeoPackage，选择路线，或人工绘制参考线；左右可独立设置逐车道宽度、中央隔离带、应急车道、路肩和边坡水平投影。
- 生成在后台调用 Rust 进程，可取消；修改路线或横断面会使旧成果失效，迟到任务不会覆盖新输入。
- 地图左下角固定底图入口，支持高德街道/卫星、Esri、NASA、OSM，以及自定义 XYZ/WMS；高德采用 GCJ-02 到 WGS84 的近似瓦片纠偏，工程计算坐标不变，在线来源只在用户选择后请求。令牌仅用于当前会话。
- 支持 WFS/PostGIS 连接、路线与横断面字段映射、本地文件多图层选择和图层内多路线选择；当前每次读取最多 2,000 个要素快照，真实远程服务仍需环境验收。
- 本地定位影像按视口生成 256 像素瓦片，使用有界缓存；无配准图片须先配准。默认无在线底图，不依赖地图账户、令牌或 CDN。
- 沿线自动布设支持护栏、轮廓标、照明、标志、里程牌和道路标线，间距与偏移按米制参考线计算；先应用再保存或导出，独立于手动设施。最多 10,000 个示意成果，偏移失败会拒绝生成。
- 设施目录包含 12 类、66 个基础子类型；点、线、区域设施保存模板快照，允许编辑、删除和撤销。人工位置与推定规格需要独立核验。
- 保存/恢复项目，导出 WGS84 GeoJSON 或带工程 CRS 的 GeoPackage。手动设施独立于道路生成结果，重新生成不覆盖人工编辑。
- 保存状态与道路生成状态分别显示；打开另一项目或关闭窗口时，未保存编辑可选择保存、放弃或取消。`Ctrl+S` 保存，`Ctrl+Z` 撤销，`Ctrl+Y` / `Ctrl+Shift+Z` 重做，`Esc` 取消输入草稿或退出绘制。
- 两侧面板可折叠、拖动调整宽度，设置在本机保留；地图图例和路线摘要可展开。横断面按真实宽度比例预览，左右分别编辑，也可复制或同步。
- 设施模板库与已放置实例分开；模板支持复制、新建和编辑，模板修改不覆盖实例快照。规格使用中文字段、单位和类型校验，编码保留前导零，额外字段在高级区保留并编辑。
- 数值输入在确认或失焦后提交，空值和越界值就地提示；坐标显示精度不改变保存精度。技术版本和 CRS 说明收在详情中。

项目 schema 2 保留 schema 1 的原字段。本轮已恢复基础沿线自动布设、完整字段映射和国内底图显示适配；专业规范规则、配准和真实三维仍须单独建设。迁移入口与验证范围见 [原版功能对照](docs/ui-migration-checklist.md)。公开在线瓦片需要遵守服务使用和缓存条件；自定义 XYZ 须明确坐标关系，不能把 GCJ-02/BD-09 瓦片直接当作 WGS84 工程背景。

## 验证与架构

```powershell
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cd desktop-tauri
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --locked
cd ..
.\launch.ps1 -SmokeTest
```

Native smoke 在独立 WebView2 配置目录中检查 Tauri 命令、生成、项目与矢量影像读写、导出，以及保存保护、数值草稿、编码、撤销重做、模板快照、横断面同步和小窗口布局，保存报告及截图。验证不关闭用户原有窗口。旧 QGIS 验证脚本仍供参考客户端运行。迁移说明与实际验证范围见 [MapLibre 重构](docs/maplibre-refactor.md)，原生适配见 [GIS 适配器](docs/maplibre-gis-adapter.md)，依赖分发说明见 [原生依赖](docs/maplibre-native-runtime.md)。

```text
Tauri / React 工作台 ─ MapLibre 地图显示与编辑草图
       │ 类型化本地命令 / 输入版本
       ├─ Rust 桌面后端：任务、取消、项目事务
       ├─ 原有 Rust 核心：横断面 → 米制道路面
       └─ GDAL / PROJ：矢量、分块影像、GeoPackage
```

现阶段处理单条路线、固定或左右不对称的横断面，每次最多 2,000 个顶点。倾斜视图不代表工程三维：真实地形、桥隧高程、坡面、点云/3D Tiles 仍需单独建设。AI 道路提取、复杂路口、沿线变宽与断链尚未实现；小样本交互测试不能证明 100 GB 影像或百万路网的生产性能。
