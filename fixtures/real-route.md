# 真实路线样例：北京西长安街

`real-route.geojson` 保存了 OpenStreetMap way **175598144** 的当前完整线几何。数据直接取自 OSM 官方 API 0.6 `way/{id}/full` 响应，保留原始节点顺序和 way 上的 OSM 标签；未拼接其它 way，也未手工改动坐标。

- 获取日期：2026-09-30
- OSM way 版本：17；way 最后编辑时间：2026-09-14 04:37:42 UTC
- 几何：13 个连续节点，WGS 84 经度、纬度（EPSG:4326）；按节点坐标计算的线长约 735 米
- OSM 标签：`highway=trunk`、`oneway=yes`、`lane_markings=yes`、`cycleway:right=lane`、`name=西长安街`
- 来源：[OSM API 原始数据](https://api.openstreetmap.org/api/0.6/way/175598144/full)；[OSM way 页面](https://www.openstreetmap.org/way/175598144)
- 许可与署名：© OpenStreetMap contributors，Open Database License (ODbL) 1.0。再分发时请保留署名并遵守 ODbL。

这是 OSM 中标记为单向的道路 way，可作为沿道路延伸的参考线样例。OSM way 的绘制位置和标签本身不能证明它是道路全幅中心线或测量成果。该数据没有提供车道宽度、中央隔离带、路肩、应急车道、断链或业务桩号；不要从 `lane_markings=yes` 推断车道数或宽度。需要横断面属性时，使用人工模板并标记为未确认，待影像判读或其它可靠资料确认。

可在高德地图搜索“北京 西长安街”并切换卫星图层检查沿线影像。GeoJSON 使用 WGS 84，高德底图使用 GCJ-02，直接叠加时应先按项目坐标规则进行转换；仅看影像不能验证 OSM 线的测量精度或道路属性。
