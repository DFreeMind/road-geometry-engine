"""标准库独立运行，验证设施模板交换及错误数据的原子隔离。"""
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "desktop"))
from facility_catalog import default_catalog, merge_catalog, read_catalog, validate_catalog, write_catalog


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.system = default_catalog()
        self.example = read_catalog(ROOT / "fixtures" / "facility-template-example.json")

    def test_catalog_is_independent(self):
        self.assertNotIn("qgis", sys.modules)
        self.assertEqual(len({item["category"] for item in self.system["entries"]}), 12)
        self.assertEqual(len(self.system["entries"]), 66)
        lamps = [item for item in self.system["entries"] if item["category"] == "照明"]
        self.assertEqual(len(lamps), 6)
        self.assertTrue(all(item["specification"]["mounting_height_m"] is None for item in lamps))

    def test_merge_copies_and_rejects_duplicates(self):
        merged = merge_catalog(self.system, self.example)
        self.assertEqual(len(merged["entries"]), 67)
        merged["entries"][0]["name"] = "新名称"
        self.assertNotEqual(self.system["entries"][0]["name"], "新名称")
        with self.assertRaises(ValueError): merge_catalog(self.example, self.example)

    def test_invalid_rules_rejected(self):
        for key, value in (("spacing_m", 0), ("spacing_m", True), ("spacing_m", float("nan")),
                           ("offset_m", -1), ("layout", "exec")):
            bad = deepcopy(self.example)
            bad["entries"][0]["placement"][key] = value
            with self.assertRaises(ValueError): validate_catalog(bad)
        for field, value in (("revision", True), ("geometry", "Unknown"), ("id", "../bad")):
            bad = deepcopy(self.example)
            bad["entries"][0][field] = value
            with self.assertRaises(ValueError): validate_catalog(bad)
        with self.assertRaises(ValueError): validate_catalog({"schema_version": True, "entries": []})
        for key, value in (("support_type", []), ("support_basis", True), ("mounting_height_m", "5 m"),
                           ("mounting_height_m", -1), ("mounting_height_m", True)):
            bad = deepcopy(self.example)
            bad["entries"][0]["specification"][key] = value
            with self.assertRaises(ValueError): validate_catalog(bad)

    def test_failed_write_keeps_original(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "catalog.json"
            write_catalog(path, self.example)
            before = path.read_bytes()
            bad = deepcopy(self.example)
            bad["entries"][0]["specification"]["power_w"] = float("inf")
            with self.assertRaises(ValueError): write_catalog(path, bad)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(read_catalog(path), self.example)

    def test_origin_metadata_is_optional_and_rejects_paths(self):
        incoming = deepcopy(self.example)
        incoming["entries"][0].update(origin="imported", import_filename="照明模板.json")
        self.assertEqual(validate_catalog(incoming), incoming)
        for key, value in (("origin", "system"), ("origin", []), ("import_filename", "C:/private/template.json"),
                           ("import_filename", "../template.json"), ("import_filename", "..\\template.json")):
            bad = deepcopy(incoming)
            bad["entries"][0][key] = value
            with self.assertRaises(ValueError): validate_catalog(bad)

    def test_span_needs_finite_metric_size_and_direction(self):
        template = deepcopy(self.system["entries"][0])
        template["specification"].update(span_m=22, span_bearing_deg=90, support_type="gantry")
        valid = {"schema_version": 1, "entries": [template]}
        self.assertEqual(validate_catalog(valid), valid)
        for key, value in (("span_m", 0), ("span_m", True), ("span_m", 201), ("span_m", float("nan")),
                           ("span_bearing_deg", None), ("span_bearing_deg", -1), ("span_bearing_deg", 360)):
            invalid = deepcopy(valid)
            invalid["entries"][0]["specification"][key] = value
            with self.assertRaises(ValueError): validate_catalog(invalid)

    def test_panel_count_rejects_invalid_imports(self):
        valid = deepcopy(self.system)
        valid["entries"][0]["specification"]["panel_count"] = 3
        self.assertEqual(validate_catalog(valid), valid)
        for value in (0, 5, True, 2.5, "3"):
            invalid = deepcopy(valid)
            invalid["entries"][0]["specification"]["panel_count"] = value
            with self.assertRaises(ValueError): validate_catalog(invalid)


if __name__ == "__main__":
    unittest.main()
