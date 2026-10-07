"""交通标志类别示意、少量标准图例和支撑符号。"""
from pathlib import Path


SUPPORT_TYPES = {
    "single_post": "单柱",
    "double_post": "双柱",
    "cantilever": "单悬臂",
    "gantry": "门架",
    "attached": "附着式",
}

_SUPPORT_ALIASES = {
    "single_post": "single_post", "单柱式": "single_post", "单柱": "single_post", "柱式": "single_post",
    "double_post": "double_post", "双柱式": "double_post", "双柱": "double_post",
    "cantilever": "cantilever", "单悬臂式": "cantilever", "单悬臂": "cantilever",
    "gantry": "gantry", "门架式": "gantry", "门架": "gantry", "限高门架": "gantry",
    "attached": "attached", "附着式": "attached", "附着": "attached",
}

# 标准图例采用可核对的标准代号；未登记的自定义代码仍退回类别示意。
# 面形由矢量路径构成，比例仅供界面识别，不表达工程尺寸。
SUPPORTED_PANELS = {
    "警35": {
        "name": "注意危险", "category": "warning",
        "markup": '<path d="M16 2.7 29.2 26H2.8Z" fill="#fff" stroke="#111827" stroke-width="1.25"/><path d="M16 4.8 27.4 24.8H4.6Z" fill="#111827"/><path d="M16 6 25.8 23.4H6.2Z" fill="#f5d000"/><path d="M16 10v6m0 3v.7" fill="none" stroke="#111827" stroke-width="1.8" stroke-linecap="round"/>',
    },
    "禁4": {
        "name": "禁止通行", "category": "prohibition",
        "markup": '<circle cx="16" cy="10" r="8" fill="#fff" stroke="#d71920" stroke-width="2.2"/>',
    },
    "示1": {
        "name": "直行", "category": "indication",
        "markup": '<circle cx="16" cy="10" r="8" fill="#0876bd"/><path d="M16 15V5m-3.2 3.2L16 5l3.2 3.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    },
    "禁1": {
        "name": "停车让行", "category": "prohibition",
        "markup": '<path d="M12.94 2.61h6.12l4.33 4.33v6.12l-4.33 4.33h-6.12l-4.33-4.33V6.94Z" fill="#d71920" stroke="#fff" stroke-width="1.1"/><text x="16" y="12.7" text-anchor="middle" font-size="5.2" font-weight="700" font-family="sans-serif" fill="#fff">停</text>',
    },
    "禁39": {
        "name": "限制速度", "category": "prohibition",
        "markup": '<circle cx="16" cy="10" r="8" fill="#fff" stroke="#d71920" stroke-width="2"/><text x="16" y="11.5" text-anchor="middle" font-size="6.1" font-weight="700" font-family="sans-serif" fill="#111827">60</text>',
    },
}

_PANEL_NAME_ALIASES = {
    "注意危险": "警35", "禁止通行": "禁4", "直行": "示1", "停车让行": "禁1",
    "限速": "禁39", "限制速度": "禁39",
}

# 类别通用图形只说明类别，不表示一个具体标准标志或编号。
_CATEGORY_PANELS = {
    0: '<path d="M16 2.7 29.2 26H2.8Z" fill="#fff" stroke="#111827" stroke-width="1.25"/><path d="M16 4.8 27.4 24.8H4.6Z" fill="#111827"/><path d="M16 6 25.8 23.4H6.2Z" fill="#f5d000"/><path d="M16 10v6m0 3v.7" fill="none" stroke="#111827" stroke-width="1.8" stroke-linecap="round"/>',
    1: '<circle cx="16" cy="10" r="8" fill="#fff" stroke="#d71920" stroke-width="2"/><path d="M10.5 15.5 21.5 4.5" fill="none" stroke="#d71920" stroke-width="1.8"/><path d="M12 10h8" fill="none" stroke="#111827" stroke-width="1.7" stroke-linecap="round"/>',
    2: '<circle cx="16" cy="10" r="8" fill="#0876bd"/><path d="M16 15V5m-3.2 3.2L16 5l3.2 3.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    3: '<rect x="4" y="3" width="24" height="14" rx=".5" fill="#0876bd"/><path d="M7 6h2m-2 3h2m-2 3h2m4 4v3" fill="none" stroke="#fff" stroke-width="1"/><path d="M13 14V8l3-2 3 2v6m-6-3h6m2 4h5" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
    4: '<rect x="4" y="3" width="24" height="14" rx=".5" fill="#80552b"/><path d="m7 13 4-6 3 4 2-2 4 4M21 6h3" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    5: '<rect x="4" y="3" width="24" height="14" rx=".5" fill="#f28c28" stroke="#111827" stroke-width=".65"/><path d="M8 13h16m-13-3h10" fill="none" stroke="#111827" stroke-width="1.3" stroke-linecap="round"/><path d="m11 7 2 2-2 2m10-4-2 2 2 2" fill="none" stroke="#111827" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/>',
    6: '<rect x="5" y="3" width="22" height="14" fill="#fff" stroke="#111827" stroke-width="1"/><path d="M8 7h16m-16 3h12m-12 3h15" fill="none" stroke="#111827" stroke-width="1.25" stroke-linecap="round"/>',
    7: '<rect x="4" y="3" width="24" height="14" rx=".5" fill="#202936" stroke="#64748b" stroke-width=".8"/><path d="M7 7h2m3 0h2m3 0h2m3 0h2M7 11h2m3 0h2m3 0h2m3 0h2" fill="none" stroke="#9de5ff" stroke-width="1.15" stroke-linecap="round"/>',
}

# 支撑地面接触点：QGIS 可据此把点符号的真实落地点贴到放置坐标。
_SUPPORT_CONTACT = {
    "single_post": (16.0, 31.2),
    "double_post": (16.0, 31.2),
    "cantilever": (4.0, 31.2),
    "gantry": (4.0, 31.2),
    "attached": (5.0, 31.2),
}

_SUPPORTS = {
    "single_post": '<path d="M16 16v13.1"/><path d="M12.8 29.1h6.4v2.1h-6.4z" fill="#64748b" stroke="none"/>',
    "double_post": '<path d="M11.3 16v13.1m9.4-13.1v13.1"/><path d="M10 29.1h12v2.1H10z" fill="#64748b" stroke="none"/>',
    "cantilever": '<path d="M4 29.1V3.2h24M18 3.2v7.2"/><path d="M2.1 29.1h3.8v2.1H2.1z" fill="#64748b" stroke="none"/>',
    "gantry": '<path d="M4 29.1V3.2h24v25.9M4 5.1h24M11 5.1v3m10-3v3"/><path d="M2.1 29.1h3.8v2.1H2.1zM26.1 29.1h3.8v2.1h-3.8z" fill="#64748b" stroke="none"/>',
    "attached": '<path d="M4 3v26.1m3-26.1v26.1"/><path d="M7 7h4m-4 5h4"/><path d="M2.8 29.1h4.4v2.1H2.8z" fill="#64748b" stroke="none"/>',
}

_PANEL_TRANSFORMS = {
    "single_post": ' transform="translate(0 0)"',
    "double_post": ' transform="translate(0 0)"',
    "cantilever": ' transform="translate(6 3) scale(.72)"',
    "gantry": ' transform="translate(4 3) scale(.75)"',
    "attached": ' transform="translate(8 3) scale(.7)"',
}


def _specification(template):
    if not isinstance(template, dict):
        return {}
    spec = template.get("specification", {})
    return spec if isinstance(spec, dict) else {}


def _known_support_type(value):
    if isinstance(value, str):
        return _SUPPORT_ALIASES.get(value.strip())
    return None


def _panel_code(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value in SUPPORTED_PANELS:
        return value
    return _PANEL_NAME_ALIASES.get(value)


def _status_marker():
    return '<circle cx="27" cy="4.6" r="2.8" fill="#fff" stroke="#d71920" stroke-width=".7"/><text x="27" y="5.8" text-anchor="middle" font-size="3.5" font-weight="700" font-family="sans-serif" fill="#d71920">?</text>'


def _sign_index(template):
    if isinstance(template, int):
        return template if 0 <= template < 8 else None
    if isinstance(template, dict):
        subtype = template.get("subtype")
        try:
            from facility_catalog import FAMILIES
            return FAMILIES["标志"][1].index(subtype)
        except (ImportError, KeyError, ValueError):
            return None
    return None


def support_defaults(template):
    """返回支撑字段的示意默认；已有规格值优先，未知参数不作推定。"""
    spec = _specification(template)
    configured_type = spec.get("support_type")
    support_type = configured_type if configured_type not in (None, "") else "single_post"
    basis = spec.get("support_basis") or (
        "manual_choice" if configured_type not in (None, "") else "schematic_default"
    )
    result = {
        "support_type": support_type,
        "support_basis": basis,
        "mounting_height_m": spec.get("mounting_height_m"),
    }
    for field in ("panel_width_m", "panel_height_m", "post_spacing_m", "foundation"):
        if field in spec:
            result[field] = spec[field]
        elif field != "foundation":
            result[field] = None
    return result


def support_anchor(template, support_type=None):
    """返回 SVG 接地点归一化坐标；参数可为模板、支撑中文名或代码名。"""
    value = support_type
    if value in (None, ""):
        if isinstance(template, dict):
            value = _specification(template).get("support_type") or "single_post"
        else:
            value = template
    normalized = _known_support_type(value) or "single_post"
    x, y = _SUPPORT_CONTACT[normalized]
    return (x / 32.0, y / 32.0)


def render_sign_support_svg(sign_index, support_type="single_post", color=None, sign_code=None, road_class=None, sign_value=None):
    """生成标志牌和支撑组合 SVG；默认类别图例均为类别示意，不代表具体编号。"""
    normalized = _known_support_type(support_type) or "single_post"
    index = _sign_index(sign_index)
    if index is None:
        raise ValueError("交通标志子类型索引无效")
    code = _panel_code(sign_code)
    unmatched_limit_value = code == "禁39" and sign_value not in (None, "", 60, 60.0, "60")
    if code and not unmatched_limit_value:
        panel = SUPPORTED_PANELS[code]["markup"]
    else:
        schematic_index = 1 if unmatched_limit_value else index
        panel = _CATEGORY_PANELS[schematic_index]
        if schematic_index == 3 and isinstance(road_class, str) and road_class.strip() in {"高速公路", "城市快速路", "expressway", "urban_expressway"}:
            panel = panel.replace('fill="#0876bd"', 'fill="#17823b"')
    if (sign_code not in (None, "") and code is None) or unmatched_limit_value:
        panel += _status_marker()
    transform = _PANEL_TRANSFORMS[normalized]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        f'<g fill="none" stroke="#64748b" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">'
        f'{_SUPPORTS[normalized]}</g>'
        f'<g{transform}>{panel}</g></svg>\n'
    )


def support_icon_path(template, support_type=None):
    """查找目录标志的支撑组合图标；未知自定义设施沿用既有几何图标。"""
    from facility_icons import icon_path

    category = template.get("category") if isinstance(template, dict) else None
    if category != "标志":
        return icon_path(template)
    index = _sign_index(template)
    if index is None:
        return icon_path(template)
    configured = support_type
    if configured in (None, ""):
        configured = support_defaults(template)["support_type"]
    normalized = _known_support_type(configured)
    if normalized is None:
        return icon_path(template)
    code = _panel_code(_specification(template).get("sign_code"))
    raw_code = _specification(template).get("sign_code")
    if raw_code not in (None, "") and code is None:
        return Path(__file__).with_name("assets") / "catalog" / f"support-code-unsupported-{normalized}.svg"
    if code:
        if code == "禁39":
            speed_value = _specification(template).get("speed_limit_kmh")
            if speed_value not in (None, "", 60, 60.0, "60"):
                return Path(__file__).with_name("assets") / "catalog" / f"support-code-unmatched-value-{normalized}.svg"
        return Path(__file__).with_name("assets") / "catalog" / f"support-code-{code}-{normalized}.svg"
    road_class = _specification(template).get("road_class")
    if index == 3 and isinstance(road_class, str) and road_class.strip() in {"高速公路", "城市快速路", "expressway", "urban_expressway"}:
        return Path(__file__).with_name("assets") / "catalog" / f"support-guide-green-{normalized}.svg"
    return Path(__file__).with_name("assets") / "catalog" / f"support-f00-t{index:02d}-{normalized}.svg"
