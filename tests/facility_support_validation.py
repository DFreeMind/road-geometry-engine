"""独立校验交通标志支撑默认值、类别图例和几何锚点。"""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "facility-assets"))
from facility_catalog import default_catalog
from facility_icons import icon_path
from facility_support import (
    SUPPORTED_PANELS,
    SUPPORT_TYPES,
    support_anchor,
    support_defaults,
    support_icon_path,
)


class FacilitySupportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = default_catalog()["entries"]
        cls.signs = [entry for entry in cls.entries if entry["category"] == "标志"]

    def test_support_choices_and_defaults_leave_engineering_values_empty(self):
        self.assertEqual(SUPPORT_TYPES, {
            "single_post": "单柱", "double_post": "双柱", "cantilever": "单悬臂",
            "gantry": "门架", "attached": "附着式",
        })
        defaults = support_defaults(self.signs[0])
        self.assertEqual(defaults["support_type"], "single_post")
        self.assertEqual(defaults["support_basis"], "schematic_default")
        self.assertIsNone(defaults["mounting_height_m"])
        self.assertIsNone(defaults["panel_width_m"])
        self.assertIsNone(defaults["panel_height_m"])

    def test_existing_custom_specification_takes_priority(self):
        entry = deepcopy(self.signs[0])
        entry["specification"].update({
            "support_type": "门架", "support_basis": "surveyed",
            "mounting_height_m": 5.25, "post_spacing_m": 26.0,
        })
        defaults = support_defaults(entry)
        self.assertEqual(defaults["support_type"], "门架")
        self.assertEqual(defaults["support_basis"], "surveyed")
        self.assertEqual(defaults["mounting_height_m"], 5.25)
        self.assertEqual(defaults["post_spacing_m"], 26.0)
        self.assertEqual(support_icon_path(entry).name, "support-f00-t00-gantry.svg")

    def test_all_catalog_icons_remain_unique_and_have_transparent_exterior(self):
        base_paths = [icon_path(entry) for entry in self.entries]
        self.assertEqual(len(set(base_paths)), 66)
        self.assertEqual(len({path.read_bytes() for path in base_paths}), 66)
        self.assertTrue(all(path.is_file() for path in base_paths))
        combo_paths = [support_icon_path(sign, support) for sign in self.signs for support in SUPPORT_TYPES]
        self.assertEqual(len(combo_paths), 40)
        self.assertEqual(len(set(combo_paths)), 40)
        self.assertTrue(all(path.is_file() for path in combo_paths))
        for path in base_paths + combo_paths:
            root = ET.parse(path).getroot()
            self.assertEqual(root.tag, "{http://www.w3.org/2000/svg}svg")
            self.assertEqual(root.attrib.get("viewBox"), "0 0 32 32")
            self.assertFalse(any(
                element.tag.endswith("rect") and element.attrib.get("x") == "0"
                and element.attrib.get("y") == "0" and element.attrib.get("width") == "32"
                and element.attrib.get("height") == "32" for element in root.iter()
            ))
        for support, marker in (("single_post", "M16 16v13.1"), ("double_post", "M11.3 16v13.1"),
                                ("cantilever", "M4 29.1V3.2"), ("gantry", "M4 29.1V3.2"),
                                ("attached", "M4 3v26.1")):
            content = support_icon_path(self.signs[0], support).read_text(encoding="utf-8")
            self.assertIn(marker, content)
            self.assertIn('fill="#f5d000"', content)

    def test_standard_figure_codes_and_names_resolve_to_specific_assets(self):
        expected = {"警35": "注意危险", "禁4": "禁止通行", "示1": "直行", "禁1": "停车让行", "禁39": "限制速度"}
        self.assertEqual({code: item["name"] for code, item in SUPPORTED_PANELS.items()}, expected)
        for code, name in (("禁4", "禁止通行"), ("示1", "直行"), ("禁1", "停车让行"), ("禁39", "限速"), ("警35", "注意危险")):
            entry = deepcopy(self.signs[0])
            entry["specification"]["sign_code"] = code
            specific = support_icon_path(entry, "single_post")
            self.assertEqual(specific.name, f"support-code-{code}-single_post.svg")
            self.assertTrue(specific.is_file())
            content = specific.read_text(encoding="utf-8")
            self.assertIn(SUPPORTED_PANELS[code]["markup"], content)
            alias_entry = deepcopy(entry)
            alias_entry["specification"]["sign_code"] = name
            self.assertEqual(support_icon_path(alias_entry).name, specific.name)

    def test_unsupported_code_and_non_example_speed_value_have_visible_status(self):
        entry = deepcopy(self.signs[0])
        entry["specification"]["sign_code"] = "未核对编号"
        unsupported = support_icon_path(entry)
        self.assertEqual(unsupported.name, "support-code-unsupported-single_post.svg")
        self.assertIn("?", unsupported.read_text(encoding="utf-8"))
        entry["specification"].update({"sign_code": "禁39", "speed_limit_kmh": 80})
        unmatched = support_icon_path(entry)
        self.assertEqual(unmatched.name, "support-code-unmatched-value-single_post.svg")
        self.assertIn("?", unmatched.read_text(encoding="utf-8"))
        self.assertNotIn(">60</text>", unmatched.read_text(encoding="utf-8"))

    def test_guide_sign_color_follows_road_class(self):
        guide = deepcopy(self.signs[3])
        guide["specification"]["road_class"] = "高速公路"
        asset = support_icon_path(guide)
        self.assertEqual(asset.name, "support-guide-green-single_post.svg")
        self.assertIn('fill="#17823b"', asset.read_text(encoding="utf-8"))
        guide["specification"]["road_class"] = "普通道路"
        self.assertEqual(support_icon_path(guide).name, "support-f00-t03-single_post.svg")

    def test_anchor_points_match_support_footings_and_accept_chinese_aliases(self):
        expected = {
            "single_post": (0.5, 31.2 / 32),
            "double_post": (0.5, 31.2 / 32),
            "cantilever": (4 / 32, 31.2 / 32),
            "gantry": (4 / 32, 31.2 / 32),
            "attached": (5 / 32, 31.2 / 32),
        }
        for code, point in expected.items():
            self.assertEqual(support_anchor(self.signs[0], code), point)
            self.assertEqual(support_anchor(self.signs[0], SUPPORT_TYPES[code]), point)
        self.assertEqual(support_anchor("门架"), expected["gantry"])
        self.assertEqual(support_anchor(self.signs[0], "invalid"), expected["single_post"])

    def test_unknown_custom_facility_keeps_geometry_icon_without_claiming_support(self):
        custom = {"id": "custom.new", "category": "自定义", "subtype": "未收录设施", "geometry": "Point",
                  "specification": {"support_type": "gantry", "mounting_height_m": None}}
        self.assertEqual(support_icon_path(custom), icon_path(custom))
        self.assertTrue(support_icon_path(custom).name.startswith("custom-"))


if __name__ == "__main__":
    unittest.main()
