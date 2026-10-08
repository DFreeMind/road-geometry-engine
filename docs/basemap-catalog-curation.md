# 底图目录取舍

> 本文记录此前精简为8项的阶段。后续新增瑞士、奥地利、捷克正射影像，并于2026-10-08补齐参考项目的三个来源，当前无需令牌目录为14项；影像验证见[高分辨率底图](free-quality-basemaps.md)，本轮新增来源见本文末尾。

工作台预设按用途分为“卫星与航空影像”“街道与路网”“地形参考”，常用目录保留八项：高德卫星、Esri 全球影像、USGS 正射影像、IGN 正射影像、高德街道、OpenStreetMap、OpenFreeMap Liberty 和 OpenTopoMap。目录排序优先展示影像来源。卡片描述只说明覆盖、数据日期提示和用途，不宣称影像为最新或保证特定区域精度。

## 常用目录之外的来源

- NASA GIBS MODIS 和 VIIRS 的最高缩放级别与地面分辨率只适合大范围观测，难以用于道路边界判读，因此从常用目录移除。
- OSM France HOT 与法语样式和 OpenStreetMap 标准街道图用途重叠，且更面向特定地区或语言，故不作为通用预设。
- Esri World Hillshade 与 OpenTopoMap 都提供地形背景，地形预设保留带等高线和道路信息的 OpenTopoMap。
- Esri Clarity 不作为默认预设，以免与全球影像重复占据常用列表。它可能具有适合历史影像查看的价值；若产品增加历史影像专题，可作为高级来源重新评估，并明确说明日期覆盖、访问条款及区域差异。
- Esri 令牌影像从常用目录移出，保留在 `AUTHENTICATED_BASEMAP_PRESETS`，继续支持已有授权用户配置。令牌只用于当前会话生成的服务 URL。
- OpenStreetMap 是开放街道数据及其地图样式，不是卫星影像服务。目录没有加入未经官方确认的 OSM 卫星瓦片地址。
- Google 卫星底图未加入预设目录；应在确认 Google 官方支持的地图 API 接入方式、密钥管理及服务条款后再单独评估，不猜测或伪造 XYZ 模板。

移除仅影响内置在线预设。用户自定义 XYZ、WMS 及本地影像入口仍沿用原配置流程。

## 2026-10-08 按用户要求补齐参考项目目录

对照 [Geo Viewer Plus](https://github.com/DFreeMind/geo-viewer-plus) 的 `defaultSources()`，新增腾讯道路兼容服务、OSM Humanitarian 与 Esri World Hillshade。此前移除 HOT 和 Hillshade 的目录取舍由本次用户明确要求更新；法语 OSM、NASA 观测影像及 Esri Clarity 仍不属于当前目录。已有高德道路/影像、OSM 标准、OpenTopoMap、Esri 影像及 OpenFreeMap 无需重复添加；OpenFreeMap 继续采用其 MapLibre Liberty 样式。

| 目录 ID | 分类与接入 | 条件与说明 |
| --- | --- | --- |
| `tencent-street` | 街道与路网；参考项目同款 `rt0.map.gtimg.com/realtimerender` 兼容入口 | 腾讯 GCJ-02；在现有显示纠偏协议中将 XYZ 行号转换为 `2^z - 1 - y`，保留业务坐标。入口与官方 SDK 接入不同，服务稳定性及使用条件以[腾讯位置服务](https://lbs.qq.com/)为准，不承诺永久免密钥使用。 |
| `osm-humanitarian` | 街道与路网；OSM France 的 HOT 样式 XYZ | 保留 OSM、HOT、OSM France 署名；[服务政策](https://www.openstreetmap.fr/usage/)要求公开访问、非营利及适度流量，不用于内网地图。卡片悬停说明展示条件；未实现批量下载或预取。 |
| `esri-hillshade` | 地形参考；`server.arcgisonline.com` 的 `Elevation/World_Hillshade` 栅格瓦片 | 保留 Esri、USGS、NOAA 署名；仅为起伏阴影背景，不替代工程高程，网络限制同样影响加载。 |

保持现有选择器布局、分类、搜索、选择状态及关闭行为。腾讯适配共用既有有界显示纠偏流程，不新增业务几何引擎。测试覆盖腾讯 TMS 首尾行、零级与横向回绕，以及高德行号保持。

157 项前端测试、修改文件 Prettier、TypeScript/Vite 和 Windows Tauri 调试构建通过，部署为 `build-20261008-114214-610`。在实际运行的独立 WebView2 工作台中，通过鼠标键盘导入定位线段、搜索并选择来源，腾讯北京与 HOT 巴黎均取得 HTTP 200 瓦片、来源加载完成、可见署名正确，源矢量图层保留；截图人工查看已显示地图。证据在 `artifacts/maplibre-qa/reference-basemaps-final/`，腾讯响应 MIME 为 `application/octet-stream`，经图像解码与显示纠偏后正常渲染。

Esri 山体阴影直连零级瓦片取得 HTTP 200、JPEG、允许跨域响应；默认网络下的实际工作台未取得影像，报告在 `artifacts/maplibre-qa/reference-hillshade-final/`，正常渲染仍待验收，不能把目录接入写成加载通过。网络差异见[Esri 访问复核](esri-image-access.md)。本轮两地点验证不等同于所有区域、DPI、中文输入法及完整发布验收。

后续按用户授权实现 Esri 原生直连，卫星影像与山体阴影在实际工作台显示验证通过，替代上述“渲染待验收”状态；最新证据和限制见[Esri修复记录](esri-image-access.md)。
