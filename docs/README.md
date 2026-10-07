# 文档导航

当前技术路线为 Tauri 2 + React/TypeScript + MapLibre GL JS + Rust，已停止 Qt 客户端路线。实现与使用说明从以下文档进入。

| 主题 | 文档 |
| --- | --- |
| 技术架构与目录职责 | [当前架构](architecture.md) |
| 环境、构建、启动、验证 | [开发指南](development.md) |
| 工作台功能与待完善范围 | [能力清单](workbench-capabilities.md) |
| 蓝白 UI 与交互精修 | [本轮改造与验证记录](ui-blue-white-refinement-20261007.md) |
| 引擎输入、输出和限制 | [本地引擎协议](engine-interface.md) |
| 数据、路线选择与属性表 | [路线选择](route-selection-workflow.md)、[属性表](route-attribute-table.md) |
| 批量生成及性能边界 | [批量生成](source-batch-generation.md)、[渲染性能](map-render-performance.md) |
| 成果与设施编辑 | [成果编辑](generated-surface-editing.md)、[设施资源](facility-assets.md) |
| GIS 与 Windows 运行资源 | [GIS 适配](maplibre-gis-adapter.md)、[部署资源](maplibre-native-runtime.md) |
| 磁盘清理 | [工作目录与磁盘空间](workspace-storage.md) |
| 设施规范依据及审查 | [设施标准](facility-standards.md)、[逐项复核](facility-audit.md) |

带日期的功能审查、连接改进、基准和路线恢复文档是历史证据，保留当轮样本、限制和结果；其中的部署路径与通过数量不代表当前版本。文件名无日期的专题文档若包含历史验证段落，同样只对该段标明的时间和样本有效。

已删除旧 Qt/PyQGIS 界面专用设计、调研和操作审计文档，其历史可从 Git 读取；当前文档不再链接已删除的客户端模块。发布验收仍须区分功能实现、自动检查、真实界面操作和干净机部署。
