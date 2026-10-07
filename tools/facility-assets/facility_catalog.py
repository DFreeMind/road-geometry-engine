"""设施目录与模板交换；只依赖标准库，不依赖 Qt、QGIS 或地图提供商。"""
from copy import deepcopy
import json
import math
from pathlib import Path
import re

SCHEMA_VERSION = 1
SAFETY_SOURCE = "https://xxgk.mot.gov.cn/jigou/glj/202103/t20210330_3545677.html"
LIGHT_SOURCE = "https://cgj.sz.gov.cn/attachment/1/1096/1096280/2076186.pdf"
SIGN_SOURCE = "https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=15B1FC09EE1AE92F1A9EC97BA3C9E451"
MARKING_SOURCE = "https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=A9BE85F3DDD0EC531B98C84B3312E240"

# 产品检索分类，可扩展；不是规范规定的全国设施总数。
FAMILIES = {
    "标志": ("Point", ["警告标志", "禁令标志", "指示标志", "指路标志", "旅游区标志", "作业区标志", "辅助标志", "可变信息标志"]),
    "标线": ("LineString", ["纵向标线", "横向标线", "导向箭头", "路面文字", "立面标记", "突起路标"]),
    "防护": ("LineString", ["波形梁护栏", "混凝土护栏", "缆索护栏", "桥梁栏杆", "开口护栏", "防撞缓冲设施"]),
    "视线诱导": ("Point", ["轮廓标", "示警桩", "示警墩", "道口标柱", "隧道轮廓带", "线形诱导标"]),
    "隔离与防落": ("LineString", ["隔离栅", "防落物网", "防落石网"]),
    "防眩与环境": ("LineString", ["防眩板", "防眩网", "声屏障", "防风栅", "防雪栅", "积雪标杆"]),
    "照明": ("Point", ["单臂路灯", "双臂路灯", "中杆照明", "高杆照明", "隧道照明", "人行照明"]),
    "信号控制": ("Point", ["机动车信号灯", "非机动车信号灯", "行人信号灯", "车道指示器", "信号控制机"]),
    "监控与检测": ("Point", ["监控摄像机", "交通检测器", "气象检测器", "车辆识别设备"]),
    "通信与收费": ("Point", ["通信设备", "紧急电话", "ETC门架", "收费车道设备"]),
    "排水与配套": ("Point", ["雨水口", "检查井", "排水沟", "电力控制箱", "管线井"]),
    "其他附属": ("Point", ["里程牌", "百米桩", "公路界碑", "限高架", "减速丘", "凸面镜", "避险车道"]),
}
GEOMETRIES = {"Point", "LineString", "Polygon"}
LAYOUTS = {"manual", "single_side", "opposite", "staggered", "median", "continuous", "section_derived", "conditional"}
SPECIFICATION_FIELDS = {
    "标志": {"sign_code": "", "panel_width_m": None, "panel_height_m": None, "support_type": "", "reflective_material": ""},
    "标线": {"color": "", "line_width_m": None, "dash_length_m": None, "gap_length_m": None, "material": ""},
    "防护": {"protection_level": "", "height_m": None, "post_spacing_m": None, "foundation": "", "transition_type": ""},
    "视线诱导": {"reflective_color": "", "height_m": None, "mounting_type": ""},
    "隔离与防落": {"height_m": None, "mesh_size_m": None, "material": "", "foundation": ""},
    "防眩与环境": {"height_m": None, "material": "", "performance_basis": ""},
    "照明": {"mounting_height_m": None, "power_w": None, "arm_length_m": None, "photometry_file": "", "luminaire_model": ""},
    "信号控制": {"signal_group": "", "support_type": "", "mounting_height_m": None, "controller_scheme": ""},
    "监控与检测": {"device_model": "", "mounting_height_m": None, "field_of_view_deg": None, "power_supply": ""},
    "通信与收费": {"device_model": "", "system_id": "", "communication_type": "", "power_supply": ""},
    "排水与配套": {"diameter_m": None, "depth_m": None, "material": "", "connection_id": ""},
    "其他附属": {"product_model": "", "width_m": None, "height_m": None, "business_station": ""},
}


def default_catalog():
    entries = []
    for family_index, (category, (geometry, subtypes)) in enumerate(FAMILIES.items()):
        for index, subtype in enumerate(subtypes):
            actual_geometry = geometry
            if subtype in {"防撞缓冲设施", "积雪标杆", "突起路标"}: actual_geometry = "Point"
            if subtype in {"隧道轮廓带", "排水沟", "减速丘"}: actual_geometry = "LineString"
            if subtype == "避险车道": actual_geometry = "Polygon"
            source = LIGHT_SOURCE if category == "照明" else SIGN_SOURCE if category == "标志" else MARKING_SOURCE if category == "标线" else SAFETY_SOURCE if family_index <= 5 else ""
            entry = {"id": f"system.f{family_index:02d}.t{index:02d}", "revision": 1,
                     "name": subtype + " · 基础模板", "category": category, "subtype": subtype,
                     "geometry": actual_geometry, "specification": deepcopy(SPECIFICATION_FIELDS[category]),
                     "placement": {"layout": "manual", "spacing_m": None, "offset_m": None},
                     "source": source, "notes": "分类检索与示意生产模板，规格待填写；不表示已完成工程设计或规范校核。"}
            if category == "照明":
                entry["notes"] += "应记录配光文件，并校核亮度/照度、均匀度及眩光；不能仅由道路宽度确定间距。"
            entries.append(entry)
    return validate_catalog({"schema_version": SCHEMA_VERSION, "entries": entries})


def _json_values(value, depth=0):
    if depth > 8: raise ValueError("模板嵌套层级过多")
    if value is None or isinstance(value, bool): return
    if isinstance(value, (int, float)):
        if not math.isfinite(value): raise ValueError("参数必须为有限数值")
        return
    if isinstance(value, str):
        if len(value) > 10000: raise ValueError("参数文本过长")
        return
    if isinstance(value, list) and len(value) <= 200:
        for item in value: _json_values(item, depth + 1)
        return
    if isinstance(value, dict) and len(value) <= 200:
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key) > 120: raise ValueError("参数名称无效")
            _json_values(item, depth + 1)
        return
    raise ValueError("参数结构无效或过大")


def validate_catalog(data):
    if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("设施库格式版本不支持")
    entries = data.get("entries")
    if not isinstance(entries, list) or len(entries) > 5000: raise ValueError("设施库应为最多 5000 项的模板列表")
    seen = set()
    fields = {"id", "revision", "name", "category", "subtype", "geometry", "specification", "placement", "source", "notes"}
    optional_fields = {"origin", "import_filename"}
    for entry in entries:
        if not isinstance(entry, dict) or not fields <= set(entry) or set(entry) - fields - optional_fields: raise ValueError("模板字段不完整或包含未知字段")
        identifier = entry["id"]
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", identifier): raise ValueError("模板 ID 无效")
        if identifier in seen: raise ValueError("模板 ID 重复：" + identifier)
        seen.add(identifier)
        if "origin" in entry:
            if not isinstance(entry["origin"], str) or entry["origin"] not in {"system", "custom", "imported"} or (entry["origin"] == "system") != identifier.startswith("system."):
                raise ValueError("模板来源与模板 ID 不一致")
        if "import_filename" in entry:
            filename = entry["import_filename"]
            if not isinstance(filename, str) or len(filename) > 200 or any(character in filename for character in "/\\:\x00") or filename in {".", ".."}:
                raise ValueError("导入来源只能记录文件名，不能记录完整路径")
        for key in ("name", "category", "subtype"):
            if not isinstance(entry[key], str) or not entry[key].strip() or len(entry[key]) > 200: raise ValueError(key + " 必须是有效文本")
        if type(entry["revision"]) is not int or entry["revision"] < 1: raise ValueError("模板版本必须为正整数")
        if entry["geometry"] not in GEOMETRIES: raise ValueError("设施几何类型无效")
        if not isinstance(entry["specification"], dict) or not isinstance(entry["placement"], dict): raise ValueError("规格和布设规则必须为对象")
        specification = entry["specification"]
        panel_count = specification.get("panel_count")
        if panel_count is not None and (type(panel_count) is not int or not 1 <= panel_count <= 4):
            raise ValueError("panel_count 必须为 1 至 4 的牌面数量")
        for key in ("support_type", "support_basis", "span_basis"):
            if specification.get(key) is not None and not isinstance(specification[key], str):
                raise ValueError(key + " 必须是文本或空值")
        height = specification.get("mounting_height_m")
        if height is not None and (type(height) not in (int, float) or not math.isfinite(height) or height < 0):
            raise ValueError("mounting_height_m 必须是非负米制数值或空值")
        span = specification.get("span_m")
        if span is not None and (type(span) not in (int, float) or not math.isfinite(span) or not 0.05 <= span <= 200):
            raise ValueError("span_m 必须是 0.05 至 200 米的有限跨度")
        bearing = specification.get("span_bearing_deg")
        if bearing is not None and (type(bearing) not in (int, float) or not math.isfinite(bearing) or not 0 <= bearing < 360):
            raise ValueError("span_bearing_deg 必须是 0 至 360（不含）的角度")
        if span is not None and bearing is None:
            raise ValueError("已知跨度需同时提供 span_bearing_deg 方向")
        placement = entry["placement"]
        if placement.get("layout") not in LAYOUTS: raise ValueError("布设方式无效")
        for key in ("spacing_m", "offset_m"):
            value = placement.get(key)
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or (value <= 0 if key == "spacing_m" else value < 0)):
                raise ValueError(key + " 数值范围无效")
        for key in ("source", "notes"):
            if not isinstance(entry[key], str): raise ValueError(key + " 必须是文本")
        _json_values(entry)
    return deepcopy(data)


def read_catalog(path):
    path = Path(path)
    if path.stat().st_size > 8 * 1024 * 1024: raise ValueError("设施库文件不能超过 8 MB")
    return validate_catalog(json.loads(path.read_text(encoding="utf-8-sig")))


def merge_catalog(current, incoming):
    current, incoming = validate_catalog(current), validate_catalog(incoming)
    duplicates = {entry["id"] for entry in current["entries"]} & {entry["id"] for entry in incoming["entries"]}
    if duplicates: raise ValueError("同名 ID 已存在，请复制为新模板或修改导入 ID：" + ", ".join(sorted(duplicates)[:5]))
    return validate_catalog({"schema_version": SCHEMA_VERSION, "entries": current["entries"] + incoming["entries"]})


def write_catalog(path, data):
    validated = validate_catalog(data)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(validated, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)
