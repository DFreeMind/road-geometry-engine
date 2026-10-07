# 地图滚轮缩放

地图画布上的垂直滚轮输入始终用于缩放。规则适用于离散鼠标滚轮、低幅度或浮点像素增量、触控板垂直滚动，以及行/页面单位的滚动；滚轮向上放大、向下缩小，缩放中心跟随指针。Ctrl 配合滚轮继续作为捏合缩放处理。纯水平滚动用于平移。

地图手势监听只接管地图画布上的事件。侧栏和弹框中的滚动继续由各自控件处理。拖动道路顶点期间，画布上的滚轮和捏合手势会被拦截并丢弃，避免地图同时移动或缩放。

相关实现和回归测试位于 `desktop-tauri/src/workbench/MapInteraction.ts` 与 `desktop-tauri/tests/map-interaction.test.ts`。

## 2026-10-07 验证

前端150项测试、Prettier、TypeScript/Vite及Windows Tauri调试构建通过，部署为 `build-20261007-183242-103`。实际运行工作台使用鼠标键盘的30项检查通过（1440×900及1024×768）：地图画布输入正负120及正负12.5增量，验证缩放方向、指针下地理位置保持、反向滚轮恢复相机、页面不滚动；侧栏和底图列表实际滚轮输入只滚动各自内容。报告：`artifacts/maplibre-qa/wheel-quality-final/ui-interaction-report.json`。

物理鼠标与触控板的不同驱动、Windows中文输入法候选窗及跨设备DPI仍需人工验收；自动注入鼠标键盘事件不等同于所有硬件验收。

综合自动回归102项通过，报告：`artifacts/maplibre-qa/wheel-quality-regression/report.json`。综合脚本混合界面与服务检查，与上述30项实际鼠标键盘操作分别记录。
