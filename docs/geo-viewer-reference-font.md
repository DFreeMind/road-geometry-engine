# 地图样式来源与离线字体图标

## 地图来源核对

参考项目 [Geo Viewer Plus](https://github.com/DFreeMind/geo-viewer-plus) 的 README 列出 OSM Standard/Humanitarian、OpenTopoMap、OpenFreeMap、Esri 和 AMap 等来源。本次检查了代码，而不只依赖 README：`src/main/java/.../MapSourceType.java` 区分 `RASTER_XYZ` 与 `MVT`；`src/main/resources/geo-viewer-plus.html` 的 `openFreeMapSource` 使用 `https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf`、`type: 'mvt'` 和 `L.vectorGrid.protobuf`，配合插件自有的矢量图层样式。这个插件实现不是一个 XYZ 栅格源。

Road Geometry Engine 使用 MapLibre GL JS，OpenFreeMap 预设因此使用官方公开 MapLibre style JSON：

```text
sourceType: "style"
styleUrl: "https://tiles.openfreemap.org/styles/liberty"
```

`styleUrl` 是完整的 MapLibre style 入口，不能传给栅格 `addSource({type: "raster", tiles: [...]})`。官方 style JSON 会引用字体、sprite 与矢量瓦片，需原样由 MapLibre 加载；其矢量 TileJSON 为 `https://tiles.openfreemap.org/planet`，样本元数据给出 `maxzoom: 14`、每周发布数据，并包含 OpenFreeMap、OpenMapTiles 和 OpenStreetMap 的署名。替换 style 会清除现有 MapLibre 自定义业务图层，因此 App 侧需在 `style.load` 后重新执行现有 `syncMap(map, projectRef.current)`；连续切换时仅由最后一次请求恢复图层。MapLibre 的 AttributionControl 从 TileJSON 读取自动署名。

OpenFreeMap 官方称其公开服务免费、无需账号或 API key、无请求数限制，也允许商业使用；没有 SLA 保证。[官方主页](https://openfreemap.org/)和 [MapLibre Quick Start](https://openfreemap.org/quick_start/)给出上述 style URL 及接入方式。本地 HTTP 抽样在 2026-10-07 返回：style JSON `200 application/json`、`Access-Control-Allow-Origin: *`；矢量 PBF `https://tiles.openfreemap.org/planet/10/518/352.pbf` 返回 `200 application/vnd.mapbox-vector-tile`、CORS `*`。Liberty style JSON 当次响应为 43,079 字节；TileJSON 响应声明 max zoom 14。

OpenTopoMap 是公开栅格 XYZ 源，预设使用 `https://a.tile.opentopomap.org/{z}/{x}/{y}.png`，最大 zoom 17。官方说明其全球地形样式由 OSM 和 SRTM 数据生成，可免费使用，但要求清晰署名 `Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA)`，并按 CC BY-SA 条件分享衍生成果；不应让大量下载压垮公共服务器，也不提供可用性保证。官方说明部分区域数据可能最多滞后约 4 周。[OpenTopoMap 使用条款和端点](https://dev.opentopomap.org/about)

2026-10-07 使用 `Origin: http://localhost:1420` 对巴黎 z10/x518/y352 瓦片抽样：OpenTopoMap 返回 `200 image/png`、CORS `*`、52,634 字节；OpenFreeMap 对应 style JSON 与 PBF 也返回 200 及 CORS `*`。以上仅证明本次请求样本可用，不代表服务 SLA、全球每个瓦片可用或成果精度。

参考仓库还显示了腾讯 compatibility URL `rt{s}.map.gtimg.com/realtimerender?...`，但本轮没有找到能证明该直接瓦片端点允许应用免 key 使用的腾讯官方公开条款，所以不将其作为新增预设，也不以实测 HTTP 200 代替服务授权依据。只有找到官方授权和服务使用说明后才适合增加。

## 字体图标资源

图标由 [Google Material Symbols Rounded](https://developers.google.com/fonts/docs/material_symbols) 本地 WOFF2 子集渲染，资源位于 `desktop-tauri/src/workbench/assets/material-symbols-rounded.woff2`，大小 15,288 字节（约 15 KB）。它经 Google Fonts CSS API 按本项目映射所需 ligature glyph names 子集化后随应用打包；运行时不访问 Google Fonts 或其他远程字体。字体使用 Apache License 2.0，完整许可文本随资源保存在 `MaterialSymbols-LICENSE.txt`。Google 官方说明 Material Symbols 可使用 icon ligatures、适合 self-hosting，许可为 Apache 2.0。

`Iconfont.tsx` 保持原 lucide 组件名，提供与 lucide 常用属性兼容的 `IconfontProps` 和 `LucideIcon`（`FC<IconfontProps>`）类型，接受 `size`、`strokeWidth`、`color`、`className`、`style`、`title`、`role`、`aria-label`、`aria-labelledby`、`aria-hidden` 等属性。每个导出对应一个经过审阅的 Material glyph 名称，不含内嵌 SVG，也没有 emoji、远程字体或方框字符回退。`strokeWidth` 将映射到 Material Symbols 的可变字重轴，`absoluteStrokeWidth` 为兼容参数保留。

| 组件导出                                                 | 本地字体 ligature                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Activity / AlertTriangle / ArrowRight / Baseline / Box   | `monitoring` / `warning` / `arrow_forward` / `horizontal_rule` / `check_box_outline_blank` |
| Check / ChevronDown / ChevronLeft / ChevronRight         | `check` / `keyboard_arrow_down` / `keyboard_arrow_left` / `keyboard_arrow_right`           |
| CircleAlert / CircleCheck / CircleHelp / Clock3          | `error` / `check_circle` / `help` / `schedule`                                             |
| Columns3 / Copy / Database / Download / FileJson         | `view_column` / `content_copy` / `database` / `download` / `data_object`                   |
| FilePlus2 / FileUp / FolderOpen / ImagePlus / Layers3    | `note_add` / `upload_file` / `folder_open` / `add_photo_alternate` / `layers`              |
| LoaderCircle / LocateFixed / Map / MapIcon / MapPinned   | `progress_activity` / `my_location` / `map` / `map` / `pin_drop`                           |
| Maximize2 / Minimize2 / Minus / MousePointer2 / Move3D   | `open_in_full` / `close_fullscreen` / `remove` / `near_me` / `open_with`                   |
| PenLine / Pencil / PencilRuler / Play / Plus             | `edit_note` / `edit` / `design_services` / `play_arrow` / `add`                            |
| Redo2 / RefreshCw / RotateCcw / Route / Save / Search    | `redo` / `refresh` / `rotate_left` / `route` / `save` / `search`                           |
| Settings2 / Trash2 / Undo2 / Upload / X                  | `settings` / `delete` / `undo` / `upload` / `close`                                        |
| ArrowDownToLine / ArrowUpFromLine / CloudOff / Crosshair | `download` / `upload` / `cloud_off` / `center_focus_strong`                                |
| PanelLeftClose / PanelLeftOpen                           | `left_panel_close` / `left_panel_open`                                                     |
| MapLibreZoomIn / MapLibreZoomOut / MapLibreCompass       | `add` / `remove` / `explore`                                                               |

MapLibre NavigationControl 默认使用内嵌 SVG 背景；`Iconfont.css` 清除该背景并通过字体伪元素替换放大、缩小和指南针符号。应用代码替换 lucide import 时，`Map as MapIcon` 可从 `Iconfont` 同名导出导入；`Map` 与 `MapIcon` 是同一个组件。`.app-icon` 始终保留独立的 inline-flex 尺寸、flex:none 和继承文字颜色，防止图标被通用 `span` 内容布局规则拉伸。

最终字体表目录核对含 GSUB、fvar、avar、gvar，确认本地资源包含 ligature 替换及可变轴；最初子集漏入 save/undo 已修正为完整 53 个名称。实际界面字形另以工作台鼠标键盘回归核验。
