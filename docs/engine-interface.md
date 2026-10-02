# 本地引擎协议 v0.1

引擎为短生命周期进程：stdin 接收一个 UTF-8 JSON 请求并等待 EOF；成功时 stdout 输出一个 JSON 响应，失败时 stderr 输出错误并以非零状态退出。没有日志混入 stdout。客户端异步读取、检查进程状态，再提交成果；取消通过终止当前计算进程实现。

## 输入

示例见 `fixtures/example-request.json`。所有点和宽度必须为有限数字，点按路线正向排列，左侧由正向切向的左法向定义。参考线为中央隔离带中心；无隔离带时位于左右道路之间。车道数组从中心向外排列，应急车道、路肩、边坡依次在车道外侧。

- `route_id`：非空路线 ID。
- `points`：米制投影坐标数组，2 到 2000 个点；不允许连续重复点。
- `crs`：非空投影坐标系标识。引擎拒绝常见经纬度 CRS 与 Web Mercator，但不解析所有 CRS；调用方必须保证坐标为适合区域的投影米制值。客户端使用 QGIS 做转换。
- `source`：可选输入来源标识；缺失为 `unknown`。这是来源记录，不是精度证明。
- `section`：左右车道宽度数组和各组成部分宽度，详见示例。一侧可以没有车道，两侧均无车道不支持；车道宽度大于零，其他宽度不小于零，总宽度不大于 200 米。

这里的宽度均为二维水平宽度；没有超高、纵坡和地形边坡模型。

## 输出

- `feature_collection`：GeoJSON 形状的内部交换对象；坐标仍是投影米制值，不能直接作为 RFC 7946 地理 GeoJSON 发布。
- `projected_crs`：对应输入投影坐标系。
- `route_length_m`：投影平面折线长度，不等于带断链的公路业务桩号。
- `paved_width_m`：车道、应急车道与路肩宽度之和。
- `platform_width_m`：铺装宽度加中央隔离带。
- `total_width_m`：平台宽度加两侧边坡水平宽度。
- `feature_count`、`elapsed_ms`、`warnings`：成果数量、进程内计算耗时和提示。

每个要素包含 `route_id`、`component`、`side`、`lane_index`（车道存在）、`width_m`、`width_unit`、`source` 与 `rule_version`。客户端补充几何来源与属性来源，导出 GeoPackage 或转换到 WGS84 导出地理 GeoJSON。

客户端 `attributes_source` 为 `manual`、`mapped_fields` 或 `mixed`，按生成任务实际采用的横断面参数来源分类。`field_mapping` 为 JSON 文本，记录逐参数字段名、字段取值或手动来源、空值回退原因、米制单位与左右定义；路线 ID 的来源独立记录，不影响横断面来源分类。读取源字段后完成有限数值、车道整数及宽度范围检查，再通过原有 Rust 请求协议生成，连接凭据不进入引擎请求或成果。

## 几何与性能边界

普通折线使用共享 miter 偏移边界和平端封口；相邻组成部分使用同一条边界，避免独立缓冲造成缝隙。折返、自交、过长转角和重叠成果拒绝生成，保留输入供人工修正。

单次处理单路线、固定横断面，不连接路口、不推断道路层级。曲线上各组成部分面积不一定等于各自宽度乘参考线长度；内外侧长度不同，应以生成面计算实际面积。

自交检查目前存在二次复杂度，顶点上限用于限制首版风险；后续再通过空间索引优化。`elapsed_ms` 不含 Python 界面处理、进程启动和地图渲染，端到端耗时需独立测量。

## 单独调用

```powershell
cargo build --release --locked
Get-Content -Raw fixtures\example-request.json | .\target\release\road-geometry-engine.exe
```

发布地理成果请使用客户端导出功能，不直接保存内部响应为地图 GeoJSON。
