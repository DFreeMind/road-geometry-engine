# Esri 影像访问失败记录

## 已核验现象

在线底图 Esri World Imagery 在请求瓦片 `15/14443/2173` 时，工作台曾显示 `AJAXError: Failed to fetch`。2026-10-07 直接请求该瓦片，带和不带 `Origin` 请求头均返回 HTTP 403、`Server: AkamaiGHost` 和 `Access Denied` HTML。另行请求 `tile/0/0/0`、服务 metadata 及同瓦片的 `server.arcgisonline.com` 入口也返回 403。该结果确认这些服务请求被拒绝；浏览器里的 `Failed to fetch` 本身不包含 HTTP 状态，不能单独据此判断为 403。

## 尚未确定

目前没有证据确认拒绝是否由出口 IP 所在地区、服务访问策略、请求频率或其他条件导致，也不能据此断言需要令牌、代理或某项客户端设置。这里记录的是本次请求的实际响应，不代表 Esri 服务对所有网络或地区都不可用。

## 工作台提示

在线瓦片请求错误按当前底图来源显示名称和重试/切换建议。可取得 HTTP 状态时明确显示 401、403 等拒绝结果；只有网络失败且没有可确认状态（例如 status 0）时，仅提示浏览器未能读取 HTTP 响应，并列出网络连接或服务方访问限制作为可能原因。提示不展示瓦片 URL 或查询参数，且注明道路成果不受底图加载影响。

## 验证与当前替代

2026-10-07，同区域的 USGS `USGSImageryOnly/MapServer/tile/15/14443/2173` 返回200、JPEG和允许跨域响应。Windows工作台 `build-20261007-184854-598` 实际鼠标键盘操作加载Hana并生成道路，选择Esri后出现明确底图失败提示（浏览器状态0），再选择USGS实际显示影像。两项检查通过，切换前后已生成成果完全保留，未发生运行异常。报告与截图：`artifacts/maplibre-qa/esri-access-final/esri-access-report.json`、`esri-access-failure.png`、`usgs-hana-recovery.png`。脚本使用独立WebView2配置，未修改用户当前工程。

前端156项测试、Prettier、TypeScript/Vite与Windows Tauri调试构建通过。客户端不能解除CDN服务端拒绝；Esri在当前网络的正常加载仍未通过，USGS只在该代表区域验证，不代表全球覆盖或影像日期保证。

实际工作台的30项鼠标键盘回归检查通过，报告：`artifacts/maplibre-qa/esri-message-regression/ui-interaction-report.json`。中文输入法、跨设备DPI和其他网络仍需人工验收；这些检查不等同于完整发布验收。
