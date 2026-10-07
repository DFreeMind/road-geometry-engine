# 公开免令牌底图核验（2026-10-07）

本记录用于说明工作台新增公开底图的来源、覆盖、更新、适用范围、授权与联网抽样结果。联网检查只请求了少量地图瓦片和服务元数据，没有批量抓取或缓存瓦片。

## 新增预设

| 预设 | 覆盖与更新 | 分辨率和道路用途 | 授权、署名与限制 |
| --- | --- | --- | --- |
| USGS 正射影像 | 美国；不同地区和缩放级别影像来源不同。USGS 服务元数据注明影像数据于 2024-06 刷新，单点拍摄日期不一。 | USGS 说明大比例尺数据以 NAIP 为主、约 1m，部分城市区有更高分辨率影像；适合美国道路及周边环境的目视检查。 | USGS The National Map 服务和数据免费且属公有领域；产品/衍生成果建议保留 “U.S. Geological Survey, National Geospatial Program” 来源说明。服务不保证可用。 |
| IGN BD ORTHO | 法国本土及部分海外领土，实际覆盖按区域而异。官方产品说明采集影像平均约 3 年、最长约 5 年；单张瓦片拍摄年代未知。 | 航空正射影像，可用于道路和地物目视核对；像元分辨率与年份随地区变化。 | BD ORTHO 产品使用 Licence Ouverte Etalab；地图上署名 “© IGN – BD ORTHO”。该预设为公开 Géoplateforme WMTS，无令牌。 |
| OSM France HOT 街道 | 全球 OSM 数据覆盖区。底层数据约每 5 分钟更新；zoom 1–11 缓存瓦片每周更新，高 zoom 按请求或更新需要生成。 | 人道主义风格强调道路和救援相关 POI；是街道渲染图，不是影像或测量底图。 | 数据遵循 ODbL；可见署名 OSM contributors 与 Humanitarian OpenStreetMap Team。OSM France 说明服务可受限或暂时不可用，须遵守其应用使用条件，不能批量请求。 |
| OSM France 法语街道 | 全球 OSM 数据覆盖区，样式和地名主要面向法语使用者。底层数据约每 5 分钟更新；zoom 0–12 瓦片每周更新，高 zoom 按请求或更新需要生成。 | 街道渲染图，最高服务级别 zoom 20；适合网络背景核对，不表示道路真实宽度或边界。 | 数据遵循 ODbL；可见署名 OSM contributors 与 OpenStreetMap France。遵守服务使用条件并避免批量请求。 |
| NASA GIBS VIIRS 真彩色 | 全球，按日数据。默认取两天前的产品日，但云、夜间和缺测仍会造成空白。 | VIIRS 中分辨率成像波段约 750m；GIBS 浏览层最高 zoom 9，只适合大范围地表概览，不适合道路边界、车道识别或测量。 | NASA GIBS 公开浏览服务，无令牌；署名 NASA GIBS / VIIRS Suomi NPP。服务或数据日不代表实时，具体影像可用性以请求结果为准。 |

USGS 服务按视图比例尺切换不同来源；不能将整个覆盖区概括为统一的 1m 影像。IGN 和 USGS 的在线影像可用于检查背景与人工判读，不取代工程控制点、数据源位置精度评估或现场核验。街道渲染更不能用制图线宽推断道路实际宽度。

## 地图界面调整与验证

比例尺、缩放和署名的下沿统一距地图画布底部 12 CSS 像素，署名向左避开缩放按钮；它们位于独立状态栏上方。顶部移除重复“当前工具”块，选中工具保留文字，其余控件保留图标、悬停标题和可访问名称。绘制提示改为最多 480px 的紧凑宽度；摘要与图例随工具条实际高度定位，避免窄窗口换行遮挡。

底图选择扩展为最多 420px 宽、520px 高，可滚动查看；保留搜索、分类、XYZ/WMS、自定义令牌提示和本地影像。新增“仅显示免 token”筛选，卡片显示覆盖、更新及用途信息，悬停可查看完整来源说明。日期未知的来源明确显示“日期以供方为准”，不推断具体拍摄时间。

本轮前端 149 项测试、格式检查及原生构建通过。实际 WebView2 工作台的鼠标键盘检查 25 项通过，记录位于 `artifacts/maplibre-qa/map-controls-public-v2/ui-interaction-report.json`。新增检查包括底部 12px 间距、工具与绘制提示精简、底图筛选和搜索，以及通过选择器加载 USGS 影像并与真实匝道叠加：捕获了实际 HTTP 200 图片瓦片响应，核对来源署名可见且不与缩放按钮重叠。截图包括 `public-usgs-road.png`、`compact-map-tools.png`、`basemap-top-anchor.png`。

既有功能的混合页面／服务／控件回归 102 项通过，报告位于 `artifacts/maplibre-qa/map-controls-public-regression/report.json`；这不是全量人工验收。图层目录检查调整为扩充后的数量、520px 高度及既有凭据按需展开行为。保存恢复检查等待实际“已打开项目”完成状态，避免同名项目的标题提前满足条件。

其余四个新增来源本轮通过 HTTP/CORS 抽样，尚未逐个进行对应覆盖区域的完整鼠标键盘地图验收；跨 DPI、中文输入法及全部区域的可用性仍待验证。自动检查的文件选择器使用隔离路径替代，未替代原生导入、保存、读取或生成引擎。

## HTTP 图片与 CORS 抽样

2026-10-07 在 Windows PowerShell 5.1 使用 `Invoke-WebRequest` 以 `Origin: http://localhost:1420` 请求单张公开图像瓦片。下表记录服务返回的 HTTP 状态、`Content-Type`、CORS 响应头和响应体字节数。所有新增服务的样本均为图像响应且返回 `Access-Control-Allow-Origin: *`。

| 来源 | 抽样地址 | HTTP | Content-Type | CORS | 大小 |
| --- | --- | --- | --- | --- | ---: |
| USGS | `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/10/357/164`（西雅图） | 200 | image/jpeg | `*` | 28,409 B |
| IGN BD ORTHO | `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX=10&TILEROW=352&TILECOL=518`（巴黎） | 200 | image/jpeg | `*` | 20,836 B |
| OSM France HOT | `https://a.tile.openstreetmap.fr/hot/10/518/352.png`（巴黎） | 200 | image/png | `*` | 47,000 B |
| OSM France FR | `https://a.tile.openstreetmap.fr/osmfr/10/518/352.png`（巴黎） | 200 | image/png | `*` | 46,645 B |
| NASA GIBS VIIRS | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2026-10-05/GoogleMapsCompatible_Level9/8/88/129.jpg`（巴黎） | 200 | image/jpeg | `*` | 12,868 B |

额外核对：USGS `USGSImageryOnly/MapServer?f=pjson` 返回 200，服务元数据坐标系为 EPSG:3857、LOD 范围 0–23，并注明数据刷新日期 2024-06；IGN WMTS GetCapabilities 返回 200、`application/xml`，响应中包含 `ORTHOIMAGERY.ORTHOPHOTOS`。样本仅证明所请求区域和日期在本次检查时成功，不代表服务 SLA、全域完整覆盖、影像精度或浏览器以外的网络可用性。

## 官方来源与使用条款

- [USGS The National Map 服务/数据授权说明](https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map)：免费、公有领域，并请求产品引用时注明来源。
- [USGS 影像服务与缓存说明](https://www.usgs.gov/faqs/what-are-urls-imagery-services-national-map-and-are-they-cached-or-dynamic)：说明 `USGSImageryOnly` 为正射影像缓存底图，各比例尺数据来源不同。
- [USGS 正射影像内容](https://www.usgs.gov/ngp-standards-and-specifications/national-map-orthoimagery-content)：说明有 1m 或更优分辨率影像及城市区域 1 英尺或更优影像。
- [IGN BD ORTHO 产品元数据](https://geoservices.ign.fr/sites/default/files/2022-10/IGNF_BDORTHOr_2-0.html)：覆盖范围、Etalab Licence Ouverte、非固定更新周期及平均 3 年/最长 5 年的影像年代说明。
- [IGN Géoplateforme 服务使用指引](https://cartes.gouv.fr/aide/fr/guides-utilisateur/utiliser-les-services-de-la-geoplateforme/)：官方 WMTS/API 使用说明。
- [OpenStreetMap France 底图说明](https://www.openstreetmap.fr/fonds-de-carte/)：可使用的样式、地图可见署名和应用接入条件；服务不保证可用。
- [OSM France tile.openstreetmap.fr 端点和更新策略](https://wiki.openstreetmap.org/wiki/FR:Serveurs/tile.openstreetmap.fr)：HOT/FR 服务地址、署名、最大 zoom 与更新机制。
- [NASA GIBS Access Basics](https://nasa-gibs.github.io/gibs-api-docs/access-basics/) 与 [GIBS Map Library Usage](https://nasa-gibs.github.io/gibs-api-docs/map-library-usage/)：WMTS 请求格式、时间参数与 MapLibre/地图库接入模式。
- [NASA GIBS 服务致谢](https://nasa-gibs.github.io/gibs-api-docs/)：建议注明影像由 NASA EOSDIS 的 Global Imagery Browse Services 提供。
- [NASA VIIRS corrected reflectance 产品信息](https://www.earthdata.nasa.gov/data/instruments/viirs)：VIIRS 仪器和数据产品背景。

## 排除项

EOxCloudless 年度层本轮未收录：按候选瓦片模板 `s2cloudless-2024` 请求的巴黎瓦片返回 404；同时官方现行说明将 2018–2025 层限制为非商业 CC BY-NC-SA 4.0，商业使用需要采购许可。若后续找到仍公开可请求的年度图层，可另行验证端点和许可后再添加。CARTO 不作为免令牌来源；其 [当前官方条款](https://www.carto.com/legal/basemap-terms/) 和 [API key 说明](https://carto.com/basemaps/apikey/) 要求使用 CARTO-issued API key。
