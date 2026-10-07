# 工作台标注 UI 收敛

按地图工作台标注调整重复摘要、图例、比例尺和示例来源入口，未重排主布局。

## 行为与验收定位

- 路线摘要默认不挂载地图浮块；“视图 → 路线摘要”显式打开，定位结果为 `[data-testid="route-map-summary"]`。
- 图例按钮并入右上 `.map-actions`，保留 `aria-label="切换图例"`。浮层为 `#map-legend-popover[data-testid="map-legend-popover"]`；点击按钮开关、点击外部关闭，Escape 关闭并将焦点还给按钮。浮层没有全屏遮罩。
- 比例尺和 Z 级别使用单个 `.map-scale-zoom[data-testid="map-scale-zoom"]` 控件，带 `role="group"` 和“地图比例尺与缩放级别”标签。
- 示例工程使用 `[data-testid="example-source-panel"]` 展示示例名称、真实 OpenStreetMap 来源及待核验说明，不渲染空来源管理器。`[data-testid="example-import-entry"]`（`aria-label="显示数据加载入口"`）展开现有“导入其他路线或数据”区域；连接/本地入口在折叠区内，普通工程仍默认展开。
- 左侧栏 `[data-testid="left-panel-toggle"]` 使用带侧栏轮廓的 CSS 折叠符号，并保留“收起/展开”文字与对应无障碍名称。

## 底图切换

MapLibre `sourceType: "style"` 走 `map.setStyle(styleUrl)`。样式加载后调用现有 `syncMap`，恢复路线、设施、生成成果、本地矢量及本地栅格图层；当前样式请求代际号用于忽略过期的 `style.load`。从矢量样式切换到 XYZ 或离线画布时会回到工作台空白样式，再恢复业务图层并按需添加 XYZ 栅格源。矢量样式透明度由服务样式预设，侧栏说明其不支持工作台的统一透明度滑块；XYZ 滑块保留原有行为。

外部样式 20 秒仍未加载时恢复离线画布并保留当前工程图层。若底图服务稍后返回或网络持续失败，仍需在实际桌面窗口确认 MapLibre 的加载错误呈现和回退后的状态提示。

## 验证

最终 Tauri 桌面已重建，`marked-ui-hana-final/ui-interaction-report.json` 的 28 项真实 WebView2 鼠标键盘检查通过：三个真实示例菜单加载和原生生成、示例导入入口展开/收起、图例关闭归焦、比例尺合并、全部字体名称字形、OpenFreeMap → OpenTopoMap → 离线画布切换、保存打开、人工编辑与重生成、1024/1440 窗口。底图切换后路线、成果及视口保留，OpenTopoMap 与 USGS 实际收到 HTTP 200 图片。

打开工程和载入示例现在等待侧栏布局及地图样式就绪，resize 后再拟合路线，避免从开始页载入时路线偏出可见画布。普通 resize 不自动重置用户视图。

验收采用独立 WebView2 配置；原生文件选择器仅提供隔离目录路径，保存读取导出仍执行实际后端。此记录不替代全量人工验收；Windows 中文输入法候选窗、真实数据库、跨设备 DPI 和断网超时人工操作仍待验收。

扩大自动回归 `marked-ui-regression-final-v3/report.json` 102 项通过，浏览器错误列表为空；此脚本混合真实控件、DOM 和服务/API 检查，不等同于 102 项全人工验收。三套 Rust fmt/test/Clippy 分别通过，引擎 29 项、服务 58 项（1 项凭据实机测试忽略）、Tauri 2 项；前端格式、149 项测试与 TypeScript/Vite 构建通过。新部署为 `build-20261007-174138-892`，启动入口指向它；现有旧版本进程未被强制关闭。
