# 本地引擎协议

唯一业务引擎位于 `src/main.rs` 和 `src/scene.rs`，协议由共享服务 `desktop-service/src/engine.rs` 管理。stdin/stdout 使用 UTF-8 JSON，诊断信息不混入 stdout。

## 调用方式

默认模式读取一个请求并等待 EOF：成功输出响应，失败写 stderr 并以非零状态退出。`--stream` 模式逐行读取请求并输出 `{"response": ...}` 或 `{"error": ...}`；单条失败不阻断后续请求。批量服务复用流式引擎进程，取消通过终止对应计算进程实现。

```powershell
cargo build --release --locked
Get-Content -Raw fixtures\example-request.json | .\target\release\road-geometry-engine.exe
```

## 输入

示例见 `fixtures/example-request.json`。点按路线正向排列，左侧由正向切向的左法向定义；参考线为中央隔离带中心，无隔离带时位于左右道路之间。车道从中心向外排列，应急车道、路肩和边坡依次位于外侧。

- `route_id`：非空路线 ID。
- `points`：至少两个有限的投影米制点，不允许连续重复点；没有 2,000 点的总数截断。
- `crs`：非空区域投影坐标系标识。引擎拒绝已识别的经纬度 CRS 和 Web Mercator，但不解析任意 CRS；共享服务使用 GDAL/PROJ 核对及转换，调用方负责保证米制坐标。
- `source`：可选来源标识，缺失为 `unknown`，不代表精度已确认。
- `section`：左右车道宽度数组及各组成部分宽度。一侧可无车道，两侧均无车道不支持；车道宽度大于零，其他宽度不小于零，总宽度不大于 200 米，断面组成数量有 64 部件保护。
- `scene_options`：可选基础沿线示意设施配置；不是规范驱动的专业设计。

每条路线采用固定横断面，宽度是二维水平宽度；没有超高、纵坡、地形边坡、业务断链或区间变宽模型。

## 输出

- `feature_collection`：内部交换几何，坐标仍为投影米制值，不能直接作为 RFC 7946 地理 GeoJSON 发布。
- `projected_crs`、`route_length_m`：工程 CRS 和几何累计长度，后者不等于带断链的业务桩号。
- `paved_width_m`、`platform_width_m`、`total_width_m`：铺装、含隔离带的平台、含两侧边坡水平投影的总宽。
- `feature_count`、`elapsed_ms`、`warnings`：数量、引擎计算耗时及提示。
- `ancillary_layers`：可选沿线示意设施层，与道路面分开组织。

道路要素记录路线、部件、侧别、车道索引、米制宽度、来源和规则版本。共享服务及客户端补充属性映射、来源和人工覆盖。地理 GeoJSON 导出转换到 WGS84，GeoPackage 导出保留工程 CRS。

## 几何与资源边界

组成部分共用偏移边界，避免分别缓冲产生接缝。急弯支持外侧圆弧连接及限定范围内的局部偏移环修复，记录规则版本与警告；无法安全处理的折返、自交或大环明确失败，不静默丢弃车道。曲线各部件面积不一定等于宽度乘参考线长度。

自交候选使用扫描方向排序与区间筛选；极端几何仍可能产生较多候选，不能承诺所有样本线性复杂度。引擎单请求保护为 16 MiB；共享批量服务每块最多 512 个任务、输入 64 MiB、完整响应 128 MiB。这些是单次传输与资源保护，不是工程总路线数限制。详细调度和失败重试见 [批量生成](source-batch-generation.md)。

`elapsed_ms` 不含完整界面交互、进程启动、导入或渲染；端到端基准需另外记录硬件、数据复杂度和冷暖缓存。代表性测试位于核心引擎单元测试及 `tests/engine_integration.py`，后者使用外部 QGIS/GEOS 独立核验，不提供客户端界面。
