# 真实道路示例

工作台“帮助 → 道路示例…”菜单使用 `desktop-tauri/src/workbench/roadExamples.ts` 中的案例清单。每份 GeoJSON 都保留 OSM way ID、数据源、获取日期、版本（如来源提供）、对象时间戳、许可证、标签及 WGS 84 坐标；原始 OSM way 坐标按节点顺序生成，没有手绘或补造道路几何。

| 案例 | OSM way | 类型 | 文件 | 来源 |
| --- | ---: | --- | --- | --- |
| 西长安街 | 175598144 | 城市主干道（`highway=trunk`，单向） | `desktop-tauri/public/real-route.geojson` | [OSM API](https://api.openstreetmap.org/api/0.6/way/175598144/full) |
| Hana Highway / HI-360 | 456494873 | 弯曲山路（`highway=tertiary`） | `desktop-tauri/public/examples/hana-highway.geojson` | [OSM API](https://api.openstreetmap.org/api/0.6/way/456494873/full.json) |
| 海湾大桥 Treasure Island 匝道 | 322962944 | 高速匝道（`highway=motorway_link`，`junction:ref=4`） | `desktop-tauri/public/examples/treasure-island-ramp.geojson` | [OSM API](https://api.openstreetmap.org/api/0.6/way/322962944/full.json) |

新增两条线于 2026-10-07 从 OpenStreetMap API 0.6 获取。Hana Highway way 的 OSM 时间戳为 2025-08-30T04:51:22Z、版本 5；匝道 way 的时间戳为 2026-02-12T06:37:36Z、版本 20。西长安街原有样例于 2026-09-30 获取，来源文件记录 OSM 时间戳和版本。数据依据 ODbL 1.0 提供，署名为 © OpenStreetMap contributors；[版权与署名说明](https://www.openstreetmap.org/copyright)。

匝道 way 没有 OSM `name` 标签。样例保留其原始 OSM 标签，并将 `destination` 与 `junction:ref` 组合成便于菜单识别的展示名，明确记录该名称是推导标签，不是 OSM 道路名。

## 使用限制

- 几何是 OSM 地图绘制的道路 way，不是经测量确认的道路中心线。way 可能表示单向车道或连接匝道；不能把它默认解释为道路中线或双向道路的共同参考线。
- 坐标依 RFC 7946 顺序存为 WGS 84 经纬度（EPSG:4326）。它们适合菜单加载和地图显示，米制几何计算应先选择并转换到适合区域的业务投影坐标系。
- OSM 参考线本身不决定车道、隔离带、路肩、应急车道或道路总宽度。菜单加载时沿用工程默认断面；模板宽度是待核验的推定输入，不能当作 OSM 测量事实或真实道路属性。各案例创建独立示例工程，使用相同的演示断面模板，不把 OSM 标签直接当作已确认的断面。
- 这些短路段用于演示参考线类型与工作台生成流程，不代表沿整条命名道路的完整路线，也不提供实地精度保证。
