# 设施目录与源资源

`tools/facility-assets/` 是无界面的资源工具目录，包含 `facility_catalog.py`、`facility_icons.py`、`facility_support.py` 和 SVG 资源。它不提供桌面客户端，不依赖 Qt/PyQGIS，也不在生产程序中执行。

系统目录包含 12 类、66 个基础子类型。类别图标、具体已支持牌面和支撑示意应区分；未知标准代号不得虚构图形。图例不代表工程结构尺寸、设计校核或位置精度。

```powershell
# 在可用 Python 3 环境中执行；不需要安装 QGIS
python scripts/create-facility-icons.py
python tests/facility_catalog_validation.py
python tests/facility_support_validation.py
```

生成脚本把 SVG 写入 `tools/facility-assets/assets/`。`scripts/prepare-maplibre.ps1` 将资源复制到 `desktop-tauri/public/assets/`；这些副本需要随前端构建提供。不要只修改复制后的 SVG，后续准备资源会覆盖它。

客户端系统目录来自 `desktop-tauri/public/catalog.json`，构建时复制到 `desktop-tauri/src-tauri/resources/catalog.json`。SVG 生成脚本不会自动改写目录 JSON；调整目录时应核对 ID、分类、子类型和图标映射，并通过资源校验及客户端相关测试。

实例保存模板快照，模板库修改不能无提示覆盖已放置实例；设施实例与道路生成成果分别管理。成果编辑和显示倍率见 [成果编辑](generated-surface-editing.md)，沿线示意布设见 [批量生成](source-batch-generation.md)。

规范与工程表达边界见 [设施标准](facility-standards.md)、[66 项复核](facility-audit.md) 和 [标志图例来源](sign-symbol-reference.md)。这些材料记录核查依据，不能替代专业设计及现场确认。
