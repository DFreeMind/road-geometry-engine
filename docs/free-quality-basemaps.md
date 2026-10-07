# 免费高分辨率底图来源

本文记录工作台内无需令牌、具有独特道路判读用途的公开底图。来源是交互式地图浏览服务；具体坐标和精度仍应结合原始数据或测量资料核验，影像的地面分辨率不等于成果位置精度。

## 新增国家级正射影像

| 目录 ID | 覆盖及分辨率 | 更新与日期 | 使用和署名 | 官方资料 |
| --- | --- | --- | --- | --- |
| `swisstopo-swissimage` | 瑞士及列支敦士登；低地和主要阿尔卑斯谷地10厘米，阿尔卑斯其他区域25厘米 | 三年轮拍；各瓦片以覆盖面积至少70%的影像航摄年份列入产品元数据，精确拍摄日需查询航摄条带 | swisstopo 免费开放；显示及发布时标注 `© swisstopo`，遵守 FSDI 公平使用条件 | [SWISSIMAGE 产品说明](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10)、[免费地理服务条款](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices)、[署名要求](https://www.swisstopo.admin.ch/en/source-reference-ogd-swisstopo) |
| `basemap-at-orthofoto` | 奥地利全国；全域29厘米，局部细节区15厘米 | 每年更新；第17和18级显示航摄年份水印 | 官方称免费使用，适用奥地利开放政府数据 CC BY；保留 `© basemap.at` 来源署名 | [正射影像服务说明](https://basemap.at/en/orthofoto/)、[basemap.at 使用许可与来源说明](https://basemap.at/) |
| `cuzk-orthophoto` | 捷克全国；彩色影像地面像素12.5厘米，2023—2024年中误差约0.19米 | 两年更新周期；当前服务提供2024—2025年影像，分区更新 | 免费开放数据，CC BY 4.0；保留 `© ČÚZK` 署名 | [ČÚZK 开放数据与许可](https://ags.cuzk.gov.cz/opendata/)、[正射影像产品与当前年份](https://geoportal.cuzk.gov.cz/Default.aspx?lng=CZ&mode=TextMeta&side=ortofoto&text=ortofoto_info) |

三个来源都是国家测绘或政府影像产品，补充现有全球影像与法国影像的区域细节。影像分辨率、航摄年份和服务可用范围会随地区变化；不得将这些浏览底图直接当作测量成果。SWISSIMAGE 服务受公平使用规则约束，适合当前视口浏览，不应对其进行无界并发或批量抓取。

## 端点及实际瓦片验证

以下验证于2026-10-07执行，均请求缩放级别高于15的实际区域影像，并附带 `Origin: https://localhost`。响应为 HTTP 200、JPEG 图像；CORS 返回允许的来源。它证明服务端点当时可从浏览器跨域读取，不构成未来服务可用性保证。

| 目录 ID | MapLibre 地址模板 | 代表地点与级别 | 验证结果 |
| --- | --- | --- | --- |
| `swisstopo-swissimage` | `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg` | 瑞士伯尔尼，46.9480°N, 7.4474°E，z17，x=34123，y=23064 | 200，`image/jpeg`，CORS `*` |
| `basemap-at-orthofoto` | `https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg` | 奥地利维也纳，48.2082°N, 16.3738°E，z18，x=142992，y=90896 | 200，`image/jpeg`，CORS `*` |
| `cuzk-orthophoto` | `https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=0&STYLES=&FORMAT=image%2Fjpeg&TRANSPARENT=false&SRS=EPSG%3A3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}` | 捷克布拉格，50.0755°N, 14.4378°E，z16；EPSG:3857 bbox `1607012.08,6459234.64,1607623.58,6459846.13` | 200，`image/jpeg`，CORS 回显请求来源 `https://localhost` |

瑞士 WMTS 的官方能力文档明确支持 EPSG:3857，并要求使用资源模板中的瓦片行列顺序；奥地利地址对应官方 WMTS 的 `google3857` 瓦片集。ČÚZK 的预切片主要使用 EPSG:5514，因此此处选择其公开 WMS 服务，并通过 EPSG:3857 BBOX 请求，不能把它当作普通 XYZ 瓦片。工作台地图采用 EPSG:3857 显示坐标，三者不需要 GCJ-02 适配。

## 官方接口与许可来源

- [swisstopo WMTS 官方文档](https://docs.geo.admin.ch/visualize-data/wmts.html)：REST 瓦片格式、坐标系、资源路径和层级。
- [basemap.at 正射影像接口说明](https://basemap.at/en/orthofoto/)：EPSG:3857、年更新、29/15厘米分辨率及飞行年份水印；[官方主页](https://basemap.at/en/)说明其数据免费并适用奥地利开放政府数据许可。
- [ČÚZK WMTS / WMS 产品元数据](https://geoportal.cuzk.gov.cz/)和[开放数据目录](https://ags.cuzk.gov.cz/opendata/)：免费访问、CC BY 4.0 许可与服务端点。工作台对该影像使用官方 WMS 服务的 EPSG:3857 GetMap 请求。

## 工作台实际加载验证

2026-10-07，在 `build-20261007-183242-103` 实际运行的Windows工作台中，分别从导入入口载入伯尔尼、维也纳、布拉格的测试定位线段（不作为真实道路案例），经实际鼠标操作选择三个影像预设。三项检查通过：正确定位覆盖区、收到HTTP200图片、MapLibre来源加载完成、可见署名正确、源矢量图层保持。

报告及截图位于 `artifacts/maplibre-qa/regional-quality-final/`，报告文件为 `regional-map-report.json`。定位线段只用于测试视口，不纳入Git。可用以下命令复现，脚本默认包含这三个地点；`ROAD_REGIONAL_MAP_CASES` 环境变量允许覆盖用例：

```powershell
.\scripts\validate-maplibre.ps1 -OutputDir artifacts/maplibre-qa/regional-quality-check -SmokeScript scripts/maplibre-regional-basemaps-smoke.mjs
```

代表地点通过不表示所有覆盖区域、航摄年份与网络环境均已验收。浏览图像时须注意地图目录标注的区域覆盖范围。
