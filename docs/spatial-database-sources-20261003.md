# 多空间数据库数据源

> 历史改进记录：本文的实现状态、数量上限、部署路径与验证结果对应文件名标明的日期。当前技术架构和能力边界见 [架构](architecture.md) 与 [能力清单](workbench-capabilities.md)。

## 当前接入范围

连接管理扩展为统一数据库选择器，已有 PG / WFS 配置及其字段映射保持兼容。保存数据库连接无需先选择路线表；文件数据库无需用户名或密码。连接类型创建后固定，避免换类型覆盖已有图层。

| 类型 | 配置和读取方式 | 当前验证范围 |
| --- | --- | --- |
| PostgreSQL / PostGIS | 数据库或 Schema；SSL；按空间表读取 | 已有真实认证、SSL、Schema 回归保留 |
| MySQL / MariaDB | 主机、端口、数据库；按空间表读取 | 本机隔离 MySQL 5.7 成功认证、空库、空间路线读取；MariaDB 服务待实测 |
| SQL Server Spatial | 数据库或 Schema；数据库/Windows 认证；ODBC、加密及证书选项 | 适配和参数检查完成；本机缺 Microsoft ODBC 18 客户端，不能声称真实连库通过 |
| Oracle Spatial | 主机、端口、Service Name、Schema；SDO 空间表 | 适配和参数检查完成；本机运行环境缺可加载 Oracle Client，真实连库待验证 |
| SQLite / SpatiaLite | 本地数据库文件；空间图层 | 真正的 SpatiaLite 文件只读连接和路线读取 |
| GeoPackage | 本地 .gpkg 文件；空间图层 | 真实只读连接、路线读取及 CRS 转换 |
| WFS | 服务地址、版本、要素类型 | 保留现有入口和规则 |

“已接入适配”不代表已经支持每一种空间数据库、每个版本和所有厂商专有几何类型。驱动加载成功也不代表用户有空间表读取权限。SQL Server/Oracle 缺少客户端时，可以保存配置；测试按钮禁用并显示具体缺失依赖，后端直接调用也会给出明确原因。

## 数据和安全边界

- 仅通过 GDAL 成熟驱动读取；原 Rust 几何引擎保持单一实现。
- 测试只查询元数据或单行诊断属性，不读取全部业务要素、不新建表、不写入源库。MySQL 只读 GDAL 无表时可能拒绝打开，测试改连 information_schema/SCHEMATA，核对目标库可见性，因此空库无需为了测试而建表。
- PostgreSQL 测试区分连接、PostGIS 扩展和 Schema USAGE。SQL Server/Oracle 查询系统目录；Schema 存在但没有确认可查询表时提示继续在读取阶段检查，不把空 Schema 当作认证失败。Oracle Schema 名称按提供的大小写查询。
- 读取路线保留 2,000 要素上限及原有有界输出；缺少 CRS 拒绝导入。显示副本转换为 WGS84，核心投影米制几何不改。SQLite/GPKG 使用明确驱动，防止仅改扩展名混用类型。
- 密码仅在当前会话内使用，不进入连接库、工程和报告。按驱动语法引用 MySQL 和 ODBC 参数，处理分隔符及引号；Oracle Easy Connect 目前拒绝该语法不能可靠表达的密码分隔字符，明确报错而非错误拼接。
- MySQL、Oracle 和文件数据库的空间列由驱动识别，当前应使用单空间列路线表；PG/SQL Server 可指定几何列。不会把普通文本或无定位图片冒充空间几何。
- 图层目录仍手工登记，字段映射按连接和图层隔离，不自动给整个数据库套同一规则。
- 连接测试最长等待 30 秒，远程读取的元数据和转换命令分别最多等待 90 秒；超时仅结束本次 GIS 子进程，不停止数据库服务。本轮没有用故意挂起的远程服务器实测超时分支。

## Windows 客户端和许可证

准备脚本复制许可为 GDAL 的 MSSQLSpatial/OCI 插件，记录哈希和外部客户端要求，不安装服务，也不复制 Microsoft/Oracle 专有客户端。Microsoft ODBC 18 需有合法可用安装；Oracle Client 的完整依赖可通过 `ORACLE_HOME` 或明确的 `ROAD_GIS_CLIENT_BIN` 提供。程序需重新启动以获取新环境变量。可以使用 `ROAD_GIS_RUNTIME` 指定经过验证的完整运行目录。

GDAL/PROJ 版本和基础依赖沿用原生资源文档；Microsoft、Oracle 客户端的分发许可未纳入本程序打包。本地开发包不等同于已完成许可与干净机器部署验收的公开安装器。真实库测试使用独立端口/数据目录，测试后停止自己启动的实例，不修改用户已有数据库服务。

官方驱动依据：[MySQL](https://gdal.org/en/stable/drivers/vector/mysql.html)、[SQL Server Spatial](https://gdal.org/en/stable/drivers/vector/mssqlspatial.html)、[Oracle Spatial](https://gdal.org/en/stable/drivers/vector/oci.html)、[SQLite / SpatiaLite](https://gdal.org/en/stable/drivers/vector/sqlite.html)、[GeoPackage](https://gdal.org/en/stable/drivers/vector/gpkg.html)。

## 本轮验证证据

- 便携桌面构建：`artifacts/maplibre-desktop/debug/build-20261003-134136-523`；TypeScript、Rust fmt、Clippy 无警告及 Rust 21 项测试通过，前端 29 项测试和 Prettier 检查通过。
- 实际 WebView2 桌面回归：`artifacts/maplibre-qa/20261003-134158-115`，85 项检查通过；保留既有宽窄窗口、地图手势、道路、保存重开和导出回归，新增多数据库驱动检测及连接读取流程。
- 隔离 MySQL 5.7 实例验证了空数据库测试、错误密码分类、正确认证、真实空间路线读取和 WGS84 显示副本；GeoPackage、SpatiaLite 使用真实空间文件。SQL Server/Oracle 仅验证表单、适配参数、缺客户端禁用测试及提示，不记作真实连库成功。
- 截图 `31-sqlserver-dependency.png`、`32-oracle-service.png`、`33-gpkg-connection.png`、`34-spatialite-connection.png`、`35-mysql-connection.png`；窄侧栏长文件路径不会撑宽选择框或裁切读取按钮。文件库没有空的高级设置区域。
- 回归修正了设施草稿保存后浮点序列化的比较：容许小于 `1e-8` 米的差异，仍验证原有 `0.25` 米编辑提交。未改业务几何计算精度。文件选择复用已有封装，仅调试回归预置选择结果；数据库读取和坐标转换均调用实际原生后端。
- MariaDB、SQL Server、Oracle 服务端及各厂商更多版本、复杂权限、多个空间列和大库性能尚未实测，不能据本轮小样本声称全面兼容所有空间数据库。
