# Windows 原生运行资源

新客户端运行时不导入 QGIS、PyQGIS、Qt 或 Python。Rust 桌面后端以参数数组启动 GDAL CLI；GDAL/PROJ 数据、命令行和 DLL 随应用资源目录提供。开发构建可使用现有 QGIS 安装作为 GDAL 分发来源，不代表产品运行依赖 QGIS。

`scripts/prepare-maplibre.ps1` 使用 MSVC dumpbin 递归解析六个命令行的 DLL 依赖，并生成 SHA256/版本清单。当前来源是 QGIS 3.44.8 发行目录中的 GDAL 3.12.2，包含 57 个 EXE/DLL，原生二进制约 136 MB。PROJ 定义、网格与 GDAL 配置另行复制；额外复制 GDAL 自身的 MSSQLSpatial、OCI 插件并记录哈希；Microsoft ODBC 和 Oracle Client 由用户环境提供，不随本轮资源分发。ECW/MrSID 等影像可选驱动仍未启用。

运行时显式设置 GDAL_DATA、PROJ_DATA、GDAL_DRIVER_PATH，并限制子进程 PATH 到打包目录、Windows 系统目录及明确配置的数据库客户端目录（`ROAD_GIS_CLIENT_BIN`、`ORACLE_HOME`）。数据库插件仅从打包的 `gis/plugins` 加载；驱动可用性通过真实 `ogrinfo --formats` 检测，不假定复制插件后即可使用。已在本机从打包资源使用独立 PATH 验证 gdalinfo、gdalsrsinfo 和 GeoJSON ogrinfo；这不等同于干净 Windows 虚拟机部署验收。程序需要 WebView2；Tauri NSIS 配置使用离线安装器，但本轮首先构建便携目录，安装器还未验收。

开发版本锁定 `desktop-tauri/pnpm-lock.yaml` 与 `src-tauri/Cargo.lock`。MapLibre GL JS 5.24.0 使用 BSD-3-Clause，Tauri 使用 MIT/Apache-2.0，React 为 MIT。MapLibre、React 与 proj4 的许可证复制到 `public/licenses` 并随前端构建提供；正式分发还需汇总全部第三方声明。

数据库密码使用 Windows Credential Manager。Windows 目标依赖锁定 keyring 4.2.0 和 windows-native-keyring-store 1.1.0，两者许可证均为 MIT OR Apache-2.0，最低 Rust 版本为 1.88；通过 Rust 宿主直接调用系统存储，无需额外密码文件或外部程序。该存储适配仅在 Windows 启用，其他平台明确返回不支持，不回退到明文存储。密码按当前 Windows 用户及连接 UUID 隔离，便携构建已验证，独立安装器与干净系统部署仍按上述范围单独验收。

GDAL 的 LICENSE.TXT 与 PROJ 的 copyright_and_licenses.csv 随数据目录复制。当前 OSGeo4W GDAL 链接闭包还包含 GEOS、SQLite、SpatiaLite、Arrow、curl、OpenSSL、Poppler、MySQL 等组件，不能把整个闭包声明为同一种宽松许可证。特别是 Poppler/MySQL 等组件的具体构建与分发条件，以及 MSVC 可再分发许可，必须按实际二进制逐项核对。当前本地开发便携目录不是已完成许可证审查的公开发行包。

正式发布应固定一套经过许可审查的 GDAL 构建，按必要驱动裁剪原生依赖，附完整 LICENSE/NOTICE，并验证 Windows 安装、卸载、非 ASCII 路径、无网运行、坐标网格缺失和缺 WebView2 情况。不要直接删除依赖闭包里的 DLL 以缩小体积；静态导入会使程序无法启动。
