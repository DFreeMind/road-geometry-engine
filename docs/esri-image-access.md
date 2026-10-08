# Esri 影像访问失败记录

> 最新状态：2026-10-08 按用户授权增加限定 Esri 图层的原生直连通道，在系统代理保持开启时，实际 Windows 工作台已显示卫星影像和山体阴影。下面保留故障排查历史，修复与验收见文末。

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

## 2026-10-08 与 Geo Viewer Plus 对比复核

用户提供了 Geo Viewer Plus 在 DataGrip 中显示 Esri 影像的截图。核对该项目的 `CustomGeoViewerContent.java` 和 `geo-viewer-plus.html`：其预设使用 `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`，通过 Leaflet `L.tileLayer` 加载图片；本工作台原预设使用 `services.arcgisonline.com`，通过 MapLibre 栅格源加载。两个域名不能仅凭服务名称相同就视为当前网络下访问结果相同。

本次在同机用 curl 直连 `server.arcgisonline.com` 的 `tile/0/0/0` 和 `tile/15/14443/2173`，均取得 HTTP 200、`image/jpeg` 与 `Access-Control-Allow-Origin: *`。直连 `services.arcgisonline.com` 的请求在限定时间内超时。系统代理处于启用状态；显式经该系统代理请求两个域名时均取得 HTTP 403、`AkamaiGHost` 与 HTML，而非影像。因此此前的拒绝记录不能扩展为 Esri 在这台机器上所有访问方式均不可用，也没有证据认为必须换地图引擎或添加令牌。

已将工作台 Esri 公开预设改为参考项目使用的 `server.arcgisonline.com`。156 项前端测试、修改文件的 Prettier 检查、TypeScript/Vite 构建及 Windows Tauri 调试构建通过，部署为 `build-20261008-113515-266`。默认网络下实际 Tauri 工作台用鼠标键盘导入定位线段、搜索并选择 Esri 后仍未取得影像；调试协议记录 `MissingAllowOriginHeader`，对应截图及报告在 `artifacts/maplibre-qa/esri-default-network/`。浏览器未暴露 HTTP 状态，因此工作台本身仍不能将这次失败直接标记为 403。代理 HTTP 测试和工作台现象一致，网络路径是后续排查重点；未读取 DataGrip 当前运行实例的网络配置，不能断言其代理行为。

临时 WebView2 代理绕过验证被自动审批拒绝（返回原因仅为 `blocked by policy`），未执行该操作，也未修改系统代理或关闭浏览器跨域检查。此次只完成地址修正及差异定位，默认工作台正常显示 Esri 仍待网络路由调整后的实际验收。

## 2026-10-08 再次复核：系统代理开启不等于地图浏览器使用代理

用户再次提供 DataGrip 中 Esri 正常显示的截图，强调系统代理处于开启状态。本次读取当前运行进程的代理相关启动参数：`datagrip64.exe`（PID 20944）的直接子进程 `cef_server.exe`（PID 61876）带有 `--no-proxy-server`。因此当前 JCEF 浏览器启动配置明确禁用代理，不能把系统代理开关当作两个客户端网络路径相同的证据。参考插件本身创建默认 `JBCefBrowser`，没有自定义代理处理代码；这一差异来自其宿主浏览器配置。

另外，在实际 Tauri WebView2 页面对同一 `server.arcgisonline.com/World_Imagery` 零级瓦片依次测试普通 `Image`、`crossOrigin=anonymous` 图片、`fetch` 及不发送 Referer 的 `fetch`。四种方式均失败；通过 CDP `Network.responseReceivedExtraInfo` 取得四个实际 HTTP 403 响应。普通图片也失败，故仅改为 Leaflet 图片加载不能解决当前工作台的访问拒绝；CORS 缺头是本次拒绝响应伴随的现象，不能将其单独认定为根因。此次补齐了之前工作台只观测到 status 0 时没有的 HTTP 状态证据。

进程证据与请求对比保存在 `artifacts/maplibre-qa/esri-request-comparison/` 的 `process-network-settings.json` 和 `request-comparison.json`。结合此前直连 200、经系统代理 403 的对照，当前证据支持网络配置差异解释。未修改用户系统代理、DataGrip 或工作台的运行时网络设置，未声称正常显示已经修复。

## 2026-10-08 修复与实际显示验收

用户明确要求修改，让影像正常加载。最终实现采用 Tauri 原生 `esri_tile` 命令和 MapLibre 的 `esri-direct` 协议：两个内置公开 Esri 预设在桌面模式转换为原生地址，由 Rust 专用 HTTP 客户端直接连接 `server.arcgisonline.com`。浏览器预览及其他底图仍沿用原地址；没有修改系统代理、全局浏览器代理、CSP、证书验证或跨域安全检查。前面的按域名 WebView2 参数尝试未通过，已撤去，不属于最终实现。

原生入口仅接受 `imagery`、`hillshade` 图层和范围内的整数瓦片坐标，不接受任意 URL。请求最多8个并发、连接超时5秒、单请求超时12秒、单瓦片上限2MiB；不跟随重定向，拒绝非JPEG/PNG数据。使用异步网络I/O和二进制IPC，不运行外部下载器，不写磁盘缓存或批量预取。缓存沿用 MapLibre 当前视口瓦片缓存。取消显示时前端丢弃返回结果；已发出的原生请求仍会完成或在12秒网络超时内结束，切换不会应用过期瓦片。可获得的 HTTP 错误继续走现有工作台提示。

158项前端测试、修改文件格式检查、TypeScript/Vite、Tauri Rust fmt/test（4项）及Clippy通过；Windows调试便携部署为 `build-20261008-121738-190`。通过实际工作台鼠标键盘导入定位线段、搜索并选择地图，完成北京Esri影像、乌鲁木齐Esri山体阴影和巴黎OSM三项检查，地图来源加载完成、原生瓦片纹理可用、署名可见、源矢量图层保留。另在天山代表区域通过实际缩小按钮验证阴影地形显示。截图已查看，报告位于 `artifacts/maplibre-qa/esri-native-verified/` 与 `artifacts/maplibre-qa/esri-hillshade-mountain/`。测试期间系统代理保持开启，原生Esri客户端按授权直连。

这是本机代表区域的实际显示验收，不代表服务在所有网络或区域永久可用。新程序需要重启工作台才能使用；干净Windows安装器、其他操作系统和必须经企业代理访问的环境仍待对应验收。
