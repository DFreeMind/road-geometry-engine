# 底图目录精简与分类

> 本文记录此前精简为8项的阶段。后续新增瑞士、奥地利、捷克正射影像，并补齐参考项目的腾讯道路、OSM Humanitarian 和 Esri 山体阴影，当前无需令牌目录为14项；最新目录与验证见[目录取舍](basemap-catalog-curation.md)，影像来源见[高分辨率底图](free-quality-basemaps.md)。

工作台的在线目录只列出 8 个常用、无需访问令牌的来源，并按用途分为“卫星与航空影像”“街道与路网”“地形参考”。目录不再要求用户先操作“免 token”筛选；搜索仅作用于这 8 项，输入变化时列表回到顶部。

卡片先显示覆盖范围，再显示适用性。来源、日期与限制等完整信息保留在卡片悬停说明中；未知拍摄或数据日期按供方为准，不推断其新旧。目录提示区也明确区分路网地图与地表影像用途。

ArcGIS 令牌影像不属于普通免费目录，放在“XYZ / WMS”页的“授权影像（ArcGIS）”折叠区。令牌输入仅保留在当前工作台会话中，通过既有 ArcGIS 预设配置应用。Google Maps 未列入目录；后续接入须使用官方授权服务和用户提供的 API key。

离线画布、本地影像入口、自定义 XYZ/WMS 地址、图层名、署名、缩放级别及服务校验行为保持可用。

## 2026-10-07 验证记录

- 前端 150 项测试通过，Prettier、TypeScript 与 Vite 构建通过；Windows Tauri 调试部署为 `build-20261007-181448-996`。
- 在实际运行的独立 WebView2 工作台中，使用 CDP 鼠标、键盘操作完成 29 项检查（1440×900 与 1024×768）。包括八项免费目录、三类排序、搜索无结果、搜索后滚动复位、授权服务展开和非法令牌提示、Escape 关闭归焦、底图切换保留道路成果、三个真实道路示例生成及保存恢复。文件选择测试仅注入路径，读写与生成仍调用原生实现。
- 综合自动回归 102 项通过，证据位于 `artifacts/maplibre-qa/basemap-curation-regression/report.json`。该脚本混合真实界面输入、DOM 操作和服务校验，独立于上述 29 项鼠标键盘检查，不作为全量人工验收。
- USGS、OpenFreeMap 与 OpenTopoMap 的运行加载检查通过。未持有 ArcGIS 有效令牌，授权服务仅验证输入错误流程，未声称完成授权在线访问。
- 证据位于 `artifacts/maplibre-qa/basemap-curation-final/ui-interaction-report.json`；目录与错误提示截图为同目录的 `curated-basemap-catalog.png` 与 `authorized-service-validation.png`。运行证据不纳入 Git。
- Windows 中文输入法候选窗、跨设备 DPI、其余影像来源在各覆盖区域的实际操作仍待人工验收；本轮自动检查不等同于完整发布验收。
