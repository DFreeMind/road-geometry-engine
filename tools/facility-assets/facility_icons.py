"""设施子类型的独立矢量图标定义，界面与地图共用。"""
from pathlib import Path
import hashlib

ICONS = {
"标志": [
'<path d="M16 4 29 27H3Z"/><path d="M16 12v7m0 4v1"/>',
'<circle cx="16" cy="16" r="12"/><path d="m7 25 18-18"/>',
'<circle cx="16" cy="16" r="12"/><path d="M16 25V9m-6 6 6-6 6 6"/>',
'<path d="M4 8h20l5 6-5 6H4Zm12 12v9M9 29h14"/>',
'<rect x="4" y="4" width="24" height="24" rx="3"/><path d="m7 23 7-11 4 6 3-4 5 9M21 8h1"/>',
'<path d="M16 4 29 27H3Z"/><circle cx="16" cy="12" r="2"/><path d="m12 21 4-6 6 5m-6-5-3-1m4 6-1 5m6-4 3 3"/>',
'<rect x="3" y="9" width="26" height="14" rx="2"/><path d="M8 14h16M8 18h12"/>',
'<rect x="2" y="6" width="28" height="19" rx="2"/><path d="M7 11h2m4 0h2m4 0h2m4 0h1M7 16h2m4 0h2m4 0h2m4 0h1M7 21h2m4 0h2m4 0h2"/>'],
"标线": [
'<path d="M6 3v26M26 3v26M16 3v5m0 5v6m0 5v5"/>',
'<path d="M4 7h24M4 13h24M4 19h24M4 25h24"/>',
'<path d="M16 29V5m-8 9 8-9 8 9M16 20l9-5"/>',
'<path d="m5 25 6-18 6 18M7 19h8M23 7v18M20 7h6"/>',
'<rect x="5" y="3" width="22" height="26"/><path d="m5 12 9-9M5 24 21 3M12 29 27 9M24 29l3-7"/>',
'<path d="m4 22 5-12h14l5 12-12 6Z"/><path d="M9 10v12h14V10"/>'],
"防护": [
'<path d="M3 10h26v8H3ZM7 18v11m18-11v11M3 13h26"/>',
'<path d="M7 6h18l4 22H3ZM10 6l2 22M22 6l-2 22"/>',
'<path d="M6 3v26M26 3v26M2 9h28M2 16h28M2 23h28"/>',
'<path d="M3 12h26M6 12v15m7-15v15m6-15v15m7-15v15M3 27h26M3 9q13-14 26 0"/>',
'<path d="M3 9h10v9H3Zm16 0h10v9H19ZM7 18v10m18-10v10m-12-9 6-6"/>',
'<path d="M3 9h18l8 7-8 7H3ZM8 9v14m5-14v14m5-14v14"/>'],
"视线诱导": [
'<path d="m12 3-3 26h14L20 3Z"/><path d="M12 8h8v5h-8"/>',
'<path d="M11 3h10v26H11ZM11 9h10m-10 7h10m-10 7h10"/>',
'<path d="m9 11-4 17h22l-4-17ZM9 16h14M13 11V4h6v7"/>',
'<path d="M5 3h5v26H5Zm17 0h5v26h-5ZM5 10h5m12 9h5M13 12h6m-6 6h6"/>',
'<path d="M3 28V16a13 13 0 0 1 26 0v12M7 27V16a9 9 0 0 1 18 0v11"/>',
'<rect x="3" y="7" width="26" height="18"/><path d="m9 11 5 5-5 5m9-10 5 5-5 5"/>'],
"隔离与防落": [
'<path d="M4 3v26m24-26v26M4 7h24v17H4m0-17 24 17M4 24 28 7M12 7v17m8-17v17"/>',
'<path d="M4 12h24v16H4m0-16 24 16M4 28l24-16M12 12v16m8-16v16M9 3l4 6m8-7-2 6"/>',
'<path d="m4 29 6-22 13-3 6 25M8 14h18M6 22h21M12 6l-1 23m10-25 2 25"/>'],
"防眩与环境": [
'<path d="M3 27h26M6 7h4v20H6Zm10-4h4v24h-4Zm10 4h3v20h-3Z"/>',
'<rect x="3" y="8" width="26" height="17"/><path d="m3 8 26 17M3 25 29 8M12 8v17m8-17v17"/>',
'<path d="M17 3v26m7-26v26M17 8h7m-7 8h7m-7 8h7M4 10q7 6 0 12m5-17q10 11 0 22"/>',
'<path d="M21 5v24m6-24v24M21 9h6m-6 8h6M3 10h10q7 0 5-5M2 17h10m-8 7h10q6 0 4 4"/>',
'<path d="M21 6v23m6-23v23M21 11h6m-6 8h6M9 3v20M3 7l12 12M3 19 15 7M1 13h16"/>',
'<path d="M15 3h4v26h-4ZM15 8h4m-4 6h4m-4 6h4M4 28l4-6 4 6"/>'],
"照明": [
'<path d="M11 29V9q0-5 6-5h8M21 4v4h7V4M6 29h10M22 12l-2 3m6-3 2 3"/>',
'<path d="M16 29V9q0-5-5-5H4m12 5q0-5 5-5h7M2 4v4h7V4m14 0v4h7V4M11 29h10"/>',
'<path d="M16 29V7M6 7h20M6 7v4m10-4v4m10-4v4M11 29h10M5 15l-2 3m13-3v3m11-3 2 3"/>',
'<path d="M16 29V8M4 8h24M5 4h5v8H5Zm9 0h4v8h-4Zm9 0h5v8h-5ZM10 29h12"/>',
'<path d="M3 29V16a13 13 0 0 1 26 0v13M8 13h5v4H8Zm11 0h5v4h-5ZM11 21l-2 4m13-4 2 4"/>',
'<path d="M16 29V15M10 15h12l-2-9h-8ZM16 6V3M11 29h10M7 12H4m24 0h-3"/>'],
"信号控制": [
'<rect x="10" y="2" width="12" height="23" rx="3"/><circle cx="16" cy="7" r="2"/><circle cx="16" cy="13" r="2"/><circle cx="16" cy="19" r="2"/><path d="M16 25v5"/>',
'<rect x="3" y="3" width="26" height="24" rx="3"/><circle cx="9" cy="19" r="4"/><circle cx="23" cy="19" r="4"/><path d="m9 19 5-9 9 9H9m5-9h5m-7-4h5"/>',
'<rect x="5" y="2" width="22" height="28" rx="3"/><circle cx="16" cy="8" r="2"/><path d="m12 16 4-5 5 4m-5-4v9l-4 6m4-6 5 6"/>',
'<rect x="3" y="3" width="26" height="26"/><path d="M16 8v16m-6-6 6 6 6-6M8 7l3 3m10-3-3 3"/>',
'<rect x="6" y="3" width="20" height="26" rx="2"/><path d="M10 7h12v7H10ZM10 20h3m6 0h3M10 25h12"/>'],
"监控与检测": [
'<path d="m4 8 16-4 5 10-16 5Zm9 10v6h12M25 7l4 7M8 10l9-2"/>',
'<path d="M3 25h26M7 25V13h18v12M12 10q4-5 8 0M9 6q7-7 14 0M12 18h8"/>',
'<circle cx="9" cy="9" r="4"/><path d="M9 2V1M2 9H1m17 11h8a4 4 0 0 0-2-7 6 6 0 0 0-11 4M15 25l-2 4m7-4-2 4m7-4-2 4"/>',
'<path d="m5 16 3-8h16l3 8v9H5ZM5 16h22M10 21h12M8 25v4m16-4v4M8 8l16 8"/>'],
"通信与收费": [
'<path d="M16 29V15M5 5q0 17 17 17ZM6 6l18-4M16 15l10-9M11 29h10"/>',
'<path d="M9 3 4 8q2 17 19 20l5-5-6-6-4 3-6-6 3-4Z"/>',
'<path d="M3 29V6h26v23M3 11h26M9 11v5m7-5v5m7-5v5M7 22h18M11 26h10"/>',
'<path d="M5 29V13h8v16M9 13V6h20M11 6l4 4m1-4 4 4m1-4 4 4M19 19h9v10h-9Z"/>'],
"排水与配套": [
'<rect x="3" y="6" width="26" height="20" rx="2"/><path d="M8 6v20m5-20v20m6-20v20m5-20v20M3 16h26"/>',
'<circle cx="16" cy="16" r="13"/><circle cx="16" cy="16" r="8"/><path d="M8 12h16M8 20h16M12 8v16m8-16v16"/>',
'<path d="M3 6h7l4 18h4l4-18h7M7 6l4 23h10l4-23M3 29h26"/>',
'<rect x="6" y="3" width="20" height="26"/><path d="m18 7-7 10h8l-5 8M23 14v4"/>',
'<path d="M3 6h26v22H3ZM3 17h26M16 6v22M8 11h2m12 12h2"/>'],
"其他附属": [
'<rect x="4" y="7" width="24" height="20" rx="2"/><path d="M8 11h16M8 16h10M8 22h16"/>',
'<path d="M10 3h12v26H10ZM10 9h12M14 14h4m-4 5h4m-4 5h4"/>',
'<path d="M8 29V9l8-6 8 6v20ZM12 13h8m-8 5h8m-8 5h8"/>',
'<path d="M4 29V5h24v24M4 12h24M16 6v6m-4-2 4 2 4-2"/>',
'<path d="M2 25q14-22 28 0ZM9 19l3 6m5-10 3 10m4-6 3 6"/>',
'<circle cx="16" cy="12" r="10"/><path d="M16 22v8M9 7q-5 4 0 10M11 30h10"/>',
'<path d="M5 29V16L19 3m-7 26V16L25 3M19 10l7 7m-10-3 7 7m-10-3 7 7"/>'],
}


def icon_path(template):
    from facility_catalog import FAMILIES
    category, subtype = template["category"], template["subtype"]
    if category in FAMILIES and subtype in FAMILIES[category][1]:
        index = FAMILIES[category][1].index(subtype)
        group = list(FAMILIES).index(category)
        return Path(__file__).with_name("assets") / "catalog" / f"f{group:02d}-t{index:02d}.svg"
    # 自定义未知子类型按点、线、面区分；不冒充标准设施图形。
    return Path(__file__).with_name("assets") / "catalog" / ("custom-" + template["geometry"] + ".svg")


def template_kind(template):
    legacy = {"警告标志": "sign", "单臂路灯": "lighting", "里程牌": "milestone", "轮廓标": "delineator", "波形梁护栏": "guardrail"}
    if template["id"].startswith("system.") and template["subtype"] in legacy: return legacy[template["subtype"]]
    return "catalog_" + hashlib.sha256(template["id"].encode()).hexdigest()[:16]
