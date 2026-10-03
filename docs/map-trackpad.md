# 地图触控板与缩放级别

地图画布支持双指滑动平移、双指捏合放大/缩小，鼠标滚轮仍使用 MapLibre 原生缩放。捏合围绕指针处地理位置缩放，拦截其 Ctrl+wheel 事件，避免工作台网页随之缩放；面板和地图浮层的滚动不由地图接管。拖动路线顶点时不处理这些手势。

触控板像素事件按动画帧合并，保留累积位移，减少重复地图更新。高速小数像素滚动与最近平移的惯性延续归入平移；明确的 100/120 离散滚轮步幅保留原生缩放。浏览器不提供设备身份，整数纯纵向触控板事件仍可能与高精度鼠标难以区分；目前没有实体触控板硬件验收，不保证所有驱动都能自动识别。

左下比例尺旁显示 `Z 16.25` 等当前地图连续缩放级别，随缩放立即更新。Z 不是高程，也不保证等于每个底图实际请求的瓦片编号；不同来源可以有各自的瓦片级别及过度缩放策略。控件使用 MapLibre 的公开 ScaleControl 生命周期和 zoom 事件，不通过界面全局重渲染更新数值。参见 [MapLibre 地图 API](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/) 与 [官方滚动缩放接口](https://maplibre.org/maplibre-gl-js/docs/API/classes/ScrollZoomHandler/)。

验证包含分类、按帧合并、捏合双向缩放、锚点、缩放上限、拖点/浮层隔离及卸载取消的单元测试；真实 Windows WebView2 用 CDP 事件验证鼠标/触控板切换、双向捏合、页面不缩放和比例尺与 Z 值同行。此类合成输入回归不替代用户设备的手感与驱动兼容性测试。

上一轮（2026-10-03）：前端 70 项单元测试、TypeScript/Vite 构建、Prettier 检查通过；真实桌面回归 87 项通过，浏览器错误 0。报告为 `artifacts/maplibre-qa/20261003-192925-269/report.json`，同目录 `45-trackpad-zoom-level.png` 为手势后缩放级别截图。该轮直接注入 Ctrl+wheel，没有覆盖原生手势入口，因此不能证明实体触控板捏合可用。

## 原生手势入口修复（同日）

用户反馈实体捏合无效后检查了锁定的 Wry 0.57.0：`src/webview2/mod.rs` 将默认 false 的 `zoom_hotkeys_enabled` 同时传给 `SetIsZoomControlEnabled` 和 `SetIsPinchZoomEnabled`。前端收到合成 Ctrl+wheel 并不意味着原生入口开启。微软也区分浏览器缩放与 Page Scale 捏合，参见 [WebView2 捏合设置](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2settings.ispinchzoomenabled)。

窗口显式设置 `zoomHotkeysEnabled: true`，前端以非 passive 捕获监听阻止 Ctrl+wheel、Ctrl+/−/0 的网页默认缩放，但不截断手势传播，画布仍接收同一事件。面板捏合不会修改地图或页面比例；普通面板滚动保持原有行为。没有额外安装原生依赖或修改用户系统触控板设置。

这次用 `Input.synthesizePinchGesture` 的 mouse 来源模拟浏览器原生触控板手势，而不是直接注入 wheel。修复前 Z 16.1966 完全不变（报告目录 `20261003-194330-693`）；修复后同一测试变为 Z 16.6021，页面 scale 始终为 1、宽度不变（`20261003-194628-111`）。原生双向捏合及侧栏隔离现为完整回归的必测项；可用 `ROAD_QA_PINCH_PROBE_ONLY=1` 单独记录手势前后状态。报告位于 `artifacts/maplibre-qa/`。

最新：前端 72 项测试、TypeScript/Vite 与格式检查通过；Rust 41 项通过、1 项凭据测试忽略，fmt/Clippy 通过；桌面回归 88 项通过、浏览器错误 0，报告为 `artifacts/maplibre-qa/20261003-194809-143/report.json`。程序为 `artifacts/maplibre-desktop/debug/build-20261003-194507-569/lujing-desktop.exe`，默认启动指针已更新。仍需在用户实体设备确认；上述结果只证实原生入口开关导致的可复现问题得到修复，不保证任意驱动都生成相同事件。
