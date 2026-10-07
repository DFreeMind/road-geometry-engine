# MapLibre GIS 数据适配器

本适配器供 Tauri 2 桌面端调用，以 GDAL/OGR 与 PROJ 命令行工具承担成熟格式读写和坐标转换。Rust 侧只组织参数、限制输入输出并管理任务，不经过 shell，也不链接第二套业务几何库。

## 运行资源

运行资源放在应用 `resource_dir()/gis`，开发时可由 `ROAD_GIS_RUNTIME` 指向相同目录结构，或使用仓库内的 `desktop-tauri/src-tauri/resources/gis`：

```text
gis/
  bin/                 # ogrinfo、ogr2ogr、gdalinfo、gdalwarp、gdal_translate、gdalsrsinfo 及其 DLL
  share/gdal/          # GDAL 数据文件
  share/proj/          # PROJ 数据文件与网格
```

每个子进程设置 `GDAL_DATA`、`PROJ_DATA`；存在随包数据库插件时将 `GDAL_DRIVER_PATH` 指向 `gis/plugins`，否则禁用外部插件搜索。PATH 默认包含随包 `gis/bin` 与 Windows 系统目录；显式配置的 `ROAD_GIS_CLIENT_BIN`、`ORACLE_HOME` 可补充数据库客户端路径，不依赖用户安装的 QGIS、Python 或系统 GIS PATH。Windows 进程使用 `CREATE_NO_WINDOW`。发布包需把原生 DLL、GDAL 数据和 PROJ 网格与工具一并纳入；当前资源由项目维护者独立准备，升级时应记录 GDAL/PROJ 版本、上游许可证和 Windows 闭包验证结果。

命令实现位于共享服务 desktop-service/src/gis.rs；Tauri 后端注册和转发命令，不另写一套 GIS 业务逻辑。

## Tauri 命令

- `query_vector_data(source, query)` 是路线数据的统一只读入口，文件、GeoPackage/SQLite 连接和 PostGIS 共用查询契约。安全通用表达式、WGS84 bbox、LIMIT+1 与 offset 在适配层执行，默认每批 500 条、最多 10,000 条；其他连接返回明确的有界快照能力，不静默忽略不支持的查询。字段、注释（来源提供时）、原始 FID、来源 CRS 与能力随结果返回。文件中的 SQLite 方言查询不等于已有索引，也不保证深分页速度。详见 [改造计划](source-neutral-data-access-plan.md)。
- `import_vector(path)` 支持 GeoJSON、SHP、GPKG，读取首层并通过 OGR 转为 WGS84 GeoJSON。最多返回 2,000 个要素；`feature_count` 为源层元数据的数量（未知时为实际读取数），`truncated` 标明结果是否截断。非 GeoJSON 缺少 CRS 时拒绝导入；没有显式 CRS 的标准 GeoJSON 按 WGS84 解释。OGR 和 JSON 输出有界，过大的几何会失败并保留源文件。
- `import_raster(path)` 支持已配准 GeoTIFF、VRT、IMG。仅读取 GDAL 元数据，要求 CRS 和可计算的 WGS84 范围，登记最多 32 个栅格源；不改写源栅格，也不生成全图重投影副本。
- `raster_tile(id, z, x, y)` 将 XYZ 瓦片范围转换为 EPSG:3857 窗口，以 `gdalwarp` 只生成 256×256 的局部 GeoTIFF，再输出带透明度的 PNG。缩放级别最高 22、同时最多两个瓦片进程，GDAL warp 工作内存和全局缓存各限制为 64 MiB，内存缓存最多 128 张瓦片。该缓存是会话级临时缓存。
- `export_geopackage(path, layers)` 接收 `{name, crs, collection}` 图层数组，逐层调用 OGR 写入同目录临时 GeoPackage，完成后原子改名。导出拒绝已有目标文件；每层临时 GeoJSON 编码仍限制为 128 MiB，最多 200 层；几何有效性检查还有独立保护。工程 JSON 与地理 GeoJSON 导出的流式写入不等于 GeoPackage 转换已取消这些限制。
- `crs_definition(crs)` 返回 `gdalsrsinfo -o proj4` 的定义，供前端 proj4 显示转换使用。
- `validate_geometry(collection, crs)` 将输入暂存为临时 GeoPackage，并通过 OGR SQLite 方言调用 GEOS `ST_IsValid` / `ST_IsValidReason`。返回 `valid`、`feature_count` 和 `invalid_features`，其中问题记录含输入要素索引、OGR FID 与 GEOS 原因；输入超过 20,000 个要素或 128 MiB 会拒绝。该检查不自动修复几何，GeoPackage 导出也会在写入前执行同一检查。

所有格式转换在 `spawn_blocking` 执行。进程参数使用 `Command` 逐项传递，stdout/stderr 持续排空且分别限制为 160 MiB / 2 MiB；瓦片任务限并发。临时目录通过析构清理，输入数据仅以只读方式打开。命令返回错误时带有来源文件或工具诊断，导入不会覆盖源数据。

## 坐标与前端约定

`import_vector.collection` 是 WGS84 GeoJSON，适合与 MapLibre 地图显示坐标配合。业务几何引擎的内部投影米制坐标应在 `export_geopackage.layers[].crs` 中明确写入其 CRS，不能把投影坐标标成 WGS84。对内部坐标执行地图显示时，前端读取 `crs_definition` 的 PROJ 定义后通过 proj4 转到地图显示坐标系。影像 bounds 的顺序是 `[west, south, east, north]`，坐标为 WGS84。

瓦片接口仅接受标准 XYZ / Web Mercator 地址；图层透明度、NoData、色彩拉伸和金字塔策略沿用 GDAL 默认值。目前不做影像重采样策略选择。路线入口可选择图层并分批查询，矢量底图仍使用兼容的有界导入接口；没有固定事务快照、键集分页或矢量瓦片。GDAL 子进程执行不代表已完成独立安装包的完整原生依赖验收。
