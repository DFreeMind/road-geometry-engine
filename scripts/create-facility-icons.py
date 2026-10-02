"""生成本项目自行绘制的设施 SVG 源资产，不使用外部图标或运行时下载。"""
from copy import deepcopy
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "desktop"))
from facility_icons import ICONS
from facility_catalog import FAMILIES
from facility_support import SUPPORT_TYPES, SUPPORTED_PANELS, render_sign_support_svg

folder = ROOT / "desktop" / "assets" / "catalog"
folder.mkdir(parents=True, exist_ok=True)
colors = ["#64748b", "#475569", "#334155", "#1d4ed8", "#80552b", "#ea7b18", "#475569", "#0284c7", "#6d28d9", "#0e7490", "#1d4ed8", "#15803d"]
for group, category in enumerate(FAMILIES):
    assert len(ICONS[category]) == len(FAMILIES[category][1])
    for index, glyph in enumerate(ICONS[category]):
        if category == "标志":
            svg = render_sign_support_svg(index, "single_post")
        else:
            svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="none" stroke="{colors[group]}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">{glyph}</g></svg>\n'
        (folder / f"f{group:02d}-t{index:02d}.svg").write_text(svg, encoding="utf-8")
        if category == "标志":
            for support_type in SUPPORT_TYPES:
                svg = render_sign_support_svg(index, support_type)
                (folder / f"support-f{group:02d}-t{index:02d}-{support_type}.svg").write_text(svg, encoding="utf-8")
for geometry, glyph in {"Point": '<circle cx="16" cy="16" r="10"/><path d="M16 10v12m-6-6h12"/>', "LineString": '<path d="m4 25 8-16 8 12 8-14"/>', "Polygon": '<path d="m4 10 14-7 11 17-16 9Z"/>'}.items():
    (folder / f"custom-{geometry}.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="none" stroke="#6d28d9" stroke-width="2.5">{glyph}</g></svg>\n', encoding="utf-8")

# 具体示例图例按标准代号生成；未知代码不在源码资源里虚构图形。
for code in SUPPORTED_PANELS:
    for support_type in SUPPORT_TYPES:
        svg = render_sign_support_svg(0, support_type, sign_code=code)
        (folder / f"support-code-{code}-{support_type}.svg").write_text(svg, encoding="utf-8")
for support_type in SUPPORT_TYPES:
    (folder / f"support-code-unsupported-{support_type}.svg").write_text(
        render_sign_support_svg(0, support_type, sign_code="未支持代码"), encoding="utf-8"
    )
    (folder / f"support-code-unmatched-value-{support_type}.svg").write_text(
        render_sign_support_svg(1, support_type, sign_code="禁39", sign_value=80), encoding="utf-8"
    )
for support_type in SUPPORT_TYPES:
    svg = render_sign_support_svg(3, support_type, road_class="高速公路")
    (folder / f"support-guide-green-{support_type}.svg").write_text(svg, encoding="utf-8")

# 兼容旧项目和自动设施的通用标志图例，采用警告类别标准外观。
(ROOT / "desktop" / "assets" / "facilities" / "sign.svg").write_text(
    render_sign_support_svg(0, "single_post"), encoding="utf-8"
)

# 将类别示意与支撑形式排成图集，便于不启动 QGIS 直接检查辨识度。
namespace = "http://www.w3.org/2000/svg"
ET.register_namespace("", namespace)
tag = lambda name: f"{{{namespace}}}{name}"
atlas = ET.Element(tag("svg"), {"viewBox": "0 0 650 770", "width": "650", "height": "770"})
ET.SubElement(atlas, tag("rect"), {"width": "650", "height": "770", "fill": "white"})
for column, (support_type, label) in enumerate(SUPPORT_TYPES.items()):
    title = ET.SubElement(atlas, tag("text"), {"x": str(164 + column * 100), "y": "22", "font-size": "13", "text-anchor": "middle", "font-family": "sans-serif"})
    title.text = label
for row, subtype in enumerate(FAMILIES["标志"][1]):
    label = ET.SubElement(atlas, tag("text"), {"x": "4", "y": str(65 + row * 88), "font-size": "11", "font-family": "sans-serif"})
    label.text = subtype + "（类别示意）"
    for column, support_type in enumerate(SUPPORT_TYPES):
        source = ET.parse(folder / f"support-f00-t{row:02d}-{support_type}.svg").getroot()
        cell = ET.SubElement(atlas, tag("svg"), {"x": str(140 + column * 100), "y": str(31 + row * 88), "width": "48", "height": "48", "viewBox": "0 0 32 32"})
        for child in list(source):
            cell.append(deepcopy(child))
ET.ElementTree(atlas).write(folder / "sign-support-atlas.svg", encoding="utf-8", xml_declaration=True)
print(f"已生成 66 个基础图标、40 个标志支撑类别示意组合、{len(SUPPORTED_PANELS) * len(SUPPORT_TYPES)} 个标准图例组合及 3 个自定义几何图标。")
