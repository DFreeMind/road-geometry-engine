# 启动页、菜单与底图入口改进（2026-10-07）

本轮保持蓝白工作台和既有左右面板布局，完善用户指出的入口位置、收起图标和默认示例问题。

## 默认进入方式

参考 [AutoCAD Start tab](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Core/files/GUID-53EC6386-50E6-4983-A2BE-33BFB46F495B.htm) 的新建、打开和最近文件入口，以及 [ArcGIS Pro 启动页](https://pro.arcgis.com/en/pro-app/3.0/help/projects/start-your-work.htm) 的项目与模板选择。采用适合本应用的空工程开始页：导入路线、打开工程、绘制参考线；有实际打开或保存记录时显示最近工程，提供真实道路案例入口。

运行时默认没有合成路线，生成按钮禁用；工程默认断面仍可设置，字段标明模板。`defaultProject()` 保留为明确的回归测试样本，实际启动使用 `emptyProject()`。新建工程支持菜单和 Ctrl+N，沿用未保存更改的保存、放弃、取消流程。

## 入口与视觉

- 顶部顺序为品牌、菜单、工程名称与状态、操作按钮。菜单采用图标、分组、快捷键提示和完整交互状态，弹层按窗口边缘避让。
- 左侧面板采用标准方向箭头；路线数据折叠区使用明确的 Chevron 图标，支持鼠标和 Enter／空格操作。
- 地图底图只保留右上入口，按钮显示当前底图，选择面板紧邻按钮下方，并随面板宽度及窗口变化定位；保留分类、搜索、自定义服务、本地影像和 Esc 焦点恢复。
- 帮助菜单提供“道路示例…”，案例分别创建独立示例工程，沿用离开当前工程的未保存提示。

## 真实道路案例

西长安街（城市主干道）、Hana Highway（弯曲山路）、Treasure Island 匝道（高速匝道）均来自实际 OSM way。使用适合当地的 UTM 米制投影计算，地图副本转换为 WGS 84。原始标签、来源、署名及获取记录见 [真实道路示例](road-examples.md)。

这些是地图道路参考线，参考线类型及断面属性须核验。加载时明确标记“模板推定，待人工核验”，不将模板车道数和宽度冒充真实道路测量值。

## 验证证据

- TypeScript／Vite 与 Windows Tauri 原生构建通过；前端 148 项测试及格式检查通过。
- `scripts/maplibre-ui-refinement-smoke.mjs` 在实际 WebView2 工作台通过 CDP 派发鼠标、键盘操作，19 项通过。覆盖空工程、折叠、新建、绘制及原生生成、三个案例加载、顶部底图、断面输入、撤销重做、成果编辑、保存恢复、最近工程和窄窗口。
- 本轮操作记录：`artifacts/maplibre-qa/startup-navigation-v2/ui-interaction-report.json`；相同运行中的截图包括 `startup-1440.png`、`basemap-top-anchor.png`、`examples-menu.png` 和三份案例截图。尺寸为 1440×900／1024×768；截图用于核对视觉，不替代操作结果。
- 更广的数据、设施和工程回归由 `scripts/maplibre-smoke.mjs` 单独执行，102 项通过，记录位于 `artifacts/maplibre-qa/startup-navigation-regression-v2`。该脚本混合页面检查、服务检查与控件操作，不等同于全功能人工验收。其合成路线只在测试启动后显式加载。

原生文件选择器在自动检查中使用路径替代；中文输入法、跨 DPI、实际数据库连接和干净 Windows 安装仍待人工验收。山路与匝道本轮验证加载及定位，未声称其断面或道路成果通过实地精度验收。
