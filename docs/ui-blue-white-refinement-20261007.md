# 蓝白工作台精修与验证记录（2026-10-07）

用户认可现有布局，并选择 A 版蓝白风格。本轮改造保留顶部菜单、左侧导航及面板、地图、右侧检查器和底部状态区，不改道路几何引擎与工程坐标规则。

## 已实现

- 集中统一蓝白主题：主色 `#2563EB`、浅灰背景、6px 圆角、32px 常规控件和 18px 线性图标；统一悬停、按下、选中、键盘焦点与禁用状态，保留减少动态效果设置。
- 顶部提供当前路线生成与成果导出入口。原生成入口保留为次级操作；导出弹框说明 GeoPackage 保留工程 CRS、GeoJSON 转为 WGS84，实际调用已有导出服务。
- 数值草稿实时校验并关联错误说明，无效草稿即时禁用生成；快捷键生成也检查同步校验状态。非法草稿不写入工程，Esc 恢复原值；零车道及总断面宽度超限也会拦截。
- 道路面板明确当前路线与左右方向，修改后提示成果待更新；右侧检查器明确属性作用范围。
- 检测到已保存的断面人工修改或组成删除规则时，重生成先显示范围并确认保留这些规则。恢复原规则仍在对应成果编辑器操作，未新增全局覆盖入口。
- 道路与断面标签支持左右箭头、Home、End 切换并移动焦点；工具按钮提供可访问的选中状态。菜单、弹框、路线文本和数值字段、读取条件等快捷键跳过输入法组合输入。
- 批量进度使用真实任务事件；停止生成使用次级操作，不改变迟到结果丢弃和原有取消语义。保存期间禁用重复点击，失败状态可重试。
- 数据加载保持独立连接管理与加载弹框的职责，保留数据库、Schema、表和页大小配置，以及读取、停止、续读/重试、选择和确认加载。确认按钮提供禁用原因，读取完成不冒充已加入工程。

## 验证结果

| 验证层级 | 本轮证据 | 结果与范围 |
| --- | --- | --- |
| 前端静态与构建 | `pnpm format:check`、TypeScript、Vite | 通过；构建仍有既有大 chunk 提示 |
| 单元测试 | `pnpm test` | 29 个文件、147 项通过；包括草稿、字段清理、组合输入判定和断面表单校验 |
| Windows 桌面构建 | `powershell.exe -File scripts/build-maplibre.ps1 -GisRoot 'C:\Program Files\QGIS 3.44.8'` | Tauri 调试部署通过，原生引擎及 GIS 资源沿用现有打包链 |
| 既有自动回归 | `artifacts/maplibre-qa/ui-blue-white-regression/report.json` | 102 项通过，包含程序化命令与控件检查，不能视为全量人工验收 |
| 实际工作台鼠标/键盘输入 | `artifacts/maplibre-qa/ui-blue-white-after/ui-interaction-report.json` | 12 项通过；通过 WebView2 CDP 发送鼠标/键盘输入，未使用 DOM click 或直接修改工程替代操作 |
| 同状态视觉核对 | `ui-blue-white-before/before-road-1440.png` 与 `ui-blue-white-after/after-road-1440.png` | 同 1440×900 视口、DPI 1、默认合成路线、相同地图范围及已生成状态；另核对 1024×768 窄窗口 |

12 项操作覆盖主题、真实原生生成、无效草稿与 F5 拦截、Esc 恢复、Enter 提交、撤销重做、标签导航、导出弹框焦点、真实 GeoJSON 导出、地图选择及成果修改后保留重生成、保存再打开、专注地图和窄窗口。该脚本的保存、打开及导出仅替代原生文件选择器的路径返回，文件与成果由真实后端写入和读取；原生文件选择器本身仍需人工验收。

## 复现

先按开发指南构建，再运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate-maplibre.ps1 -OutputDir artifacts/maplibre-qa/ui-blue-white-after -SmokeScript scripts/maplibre-ui-refinement-smoke.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/validate-maplibre.ps1 -OutputDir artifacts/maplibre-qa/ui-blue-white-regression
```

验证入口使用独立 WebView2 配置与合成数据。截图、日志、工程和导出文件都保留在被 Git 忽略的 `artifacts/` 中，不提交用户数据。

## 尚待验收

Windows 中文输入法候选窗的人工操作、原生文件选择器、真实数据库/线上底图以及跨设备 DPI 尚待验证。组合输入判定的单元检查不替代实际输入法验收；本轮未进行干净 Windows 安装或独立安装器验收。
