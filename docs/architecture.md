# 当前技术架构

技术路线已确定为 Tauri 2 + React/TypeScript + MapLibre GL JS + Rust。只维护一个桌面客户端和一个道路业务几何引擎。

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| 桌面工作台 | `desktop-tauri/src/workbench/` | React 表单、菜单、地图交互、编辑历史与显示任务 |
| 地图 | MapLibre GL JS | WGS84 显示副本、底图、图层、绘制和选取 |
| 桌面适配 | `desktop-tauri/src-tauri/src/` | 窗口、Tauri 命令、事件与共享服务接线 |
| 共享业务服务 | `desktop-service/src/` | 数据读写、坐标转换、项目、凭据、生成调度与取消 |
| 道路几何引擎 | `src/main.rs`、`src/scene.rs` | 横断面道路面、偏移边界与沿线示意设施 |
| 设施资源工具 | `tools/facility-assets/` | 无界面的目录校验与 SVG 源资源；Python 不参与客户端运行 |

```text
React 工作台 / MapLibre
        │ Tauri 命令与事件
Tauri Rust 适配层
        │ 库调用
desktop-service
        ├─ 独立 Rust 引擎进程：投影米制道路生成
        └─ GDAL/OGR CLI + PROJ/GEOS 运行资源：读写、投影、有效性检查
```

Tauri 在 Windows 使用 WebView2。共享服务本身是 Rust 库，没有单独的桌面界面或 Qt 服务可执行程序。前端的坐标显示、草图和显示处理不构成第二套道路业务引擎。

## 坐标与数据

计算使用带明确 CRS 的区域投影米制坐标。MapLibre 显示副本和地理 GeoJSON 导出转换为 WGS84；GeoPackage 导出保留工程 CRS。内部具有 GeoJSON 结构的投影几何不能直接作为 RFC 7946 地理成果发布。国内底图纠偏仅用于显示，不改变计量坐标。

当前工程保存为 schema 2 JSON，兼容旧 schema 1；GeoPackage 是矢量读写与工程 CRS 导出载体。以 GeoPackage 空间索引承载全部项目原始几何和成果仍是后续工作，不能把目标架构写成已实现能力。

工程保留来源、规则版本、模板快照和人工覆盖。重新生成不能覆盖人工设施；连接密码由系统凭据管理器保存，不写入工程、日志或成果文件。

## 任务与性能边界

Tauri 重型业务调用交给阻塞工作线程，几何生成运行在独立子进程；批量任务分块执行并支持取消、进度及输入版本检查。前端使用 Worker 处理显示与部分编辑准备。影像按视口产生瓦片并使用有界缓存。

分页读取的传输批次大小不是来源总量上限。原始矢量和成果目前仍驻留工程与地图内存中；百万复杂面、超大影像、跨 GPU 与干净 Windows 安装尚需实测验收。详情见 [批量生成](source-batch-generation.md)、[显示性能](map-render-performance.md) 和 [部署资源](maplibre-native-runtime.md)。

## 开发约束

界面改动复用现有工作台组件和样式；业务能力落在共享服务或唯一引擎，Tauri 层保持薄适配。原生格式、投影和拓扑能力复用成熟 GIS 工具，不自行另建 GIS 渲染引擎。构建环境与生产运行依赖分别记录，版本以锁文件及部署清单为准。
