r"""Independent QGIS/GEOS integration checks for road-geometry-engine.

Run from the repository root in the configured QGIS Python environment:
    . .\scripts\qgis-env.ps1
    $runtimeRoot = Initialize-RoadQgisEnvironment
    & (Join-Path $runtimeRoot 'bin\python.exe') .\tests\engine_integration.py
"""

from __future__ import annotations

import json
import math
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

from qgis.core import Qgis, QgsGeometry
from osgeo import gdal, ogr, osr


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "target" / "release" / "road-geometry-engine.exe"
REPORT = ROOT / "artifacts" / "engine-integration-report.json"
CRS = "EPSG:32610"
ORIGIN = (448000.0, 4420000.0)


def section(**overrides):
    data = {
        "left_lanes": [3.6, 3.3],
        "right_lanes": [3.5, 3.2],
        "median_width": 2.0,
        "left_emergency_width": 1.0,
        "right_emergency_width": 0.75,
        "left_shoulder_width": 0.8,
        "right_shoulder_width": 1.1,
        "left_slope_width": 2.5,
        "right_slope_width": 3.0,
    }
    data.update(overrides)
    return data


def request(points, cross_section=None, route_id="integration"):
    return {
        "route_id": route_id,
        "points": points,
        "crs": CRS,
        "source": "qgis-independent-integration",
        "section": cross_section or section(),
    }


def invoke(payload, expect_success=True):
    started = time.perf_counter()
    proc = subprocess.run(
        [str(ENGINE)], input=json.dumps(payload), text=True,
        capture_output=True, cwd=ROOT, timeout=60,
    )
    wall_ms = (time.perf_counter() - started) * 1000.0
    if expect_success and proc.returncode != 0:
        raise AssertionError(f"engine rejected valid input: {proc.stderr.strip()}")
    if not expect_success and proc.returncode == 0:
        raise AssertionError("engine unexpectedly accepted invalid input")
    if not expect_success:
        return None, wall_ms, proc.stderr.strip()
    try:
        response = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"engine did not emit JSON: {proc.stdout!r}; {proc.stderr!r}") from exc
    return response, wall_ms, None


def geom(feature):
    coords = feature["geometry"]["coordinates"][0]
    ring = ", ".join(f"{x} {y}" for x, y in coords)
    return QgsGeometry.fromWkt(f"POLYGON(({ring}))")


def line_length(points):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))


def validate_result(response, requested, context, expected_widths=None, check_feature_area=True):
    fc = response["feature_collection"]
    assert fc["type"] == "FeatureCollection", context
    features = fc["features"]
    assert len(features) == response["feature_count"] > 0, context
    geometries = [geom(f) for f in features]
    for i, (feature, geometry) in enumerate(zip(features, geometries)):
        assert not geometry.isNull() and not geometry.isEmpty(), (context, i)
        assert geometry.isGeosValid(), (context, i, geometry.validateGeometry())
        area = geometry.area()
        if check_feature_area:
            expected = feature["properties"]["width_m"] * line_length(requested["points"])
            # Straight sections have exact width times length. Curved offset
            # bands redistribute area between the inside and outside of bends.
            assert abs(area - expected) <= max(1.0e-5, expected * 2.0e-7), (
                context, feature["properties"], area, expected
            )
        assert feature["properties"]["width_unit"] == "m", context
    sum_area = sum(g.area() for g in geometries)
    union = QgsGeometry.unaryUnion(geometries)
    assert union.isGeosValid(), (context, union.validateGeometry())
    # An independently computed union must retain all component area. This
    # catches overlaps and gaps that change the expected total footprint.
    assert abs(sum_area - union.area()) <= max(1.0e-5, sum_area * 2.0e-8), (
        context, sum_area, union.area()
    )
    total_width = response["total_width_m"]
    expected_union_area = total_width * line_length(requested["points"])
    assert abs(union.area() - expected_union_area) <= max(1.0e-4, expected_union_area * 3.0e-7), (
        context, union.area(), expected_union_area
    )
    if expected_widths:
        for name, value in expected_widths.items():
            assert abs(value - response[name]) <= 1.0e-9, (context, name, value, response[name])
    return {"feature_count": len(features), "union_area_m2": union.area(), "sum_area_m2": sum_area}


def arc_points(count, length=100.0, radius=250.0):
    angle = length / radius
    return [
        [ORIGIN[0] + radius * math.sin(angle * i / (count - 1)),
         ORIGIN[1] + radius * (1.0 - math.cos(angle * i / (count - 1)))]
        for i in range(count)
    ]


def main():
    if not ENGINE.is_file():
        raise FileNotFoundError(f"release engine not found: {ENGINE}")
    results = {}

    # Eastbound 100 m straight: left is +Y, paved excludes the median,
    # platform includes it, and total includes both horizontal slope projections.
    straight = request([[ORIGIN[0], ORIGIN[1]], [ORIGIN[0] + 100.0, ORIGIN[1]]])
    response, wall, _ = invoke(straight)
    # paved = lane 13.6 + emergency 1.75 + shoulder 1.9 = 17.25
    # platform = 19.25; total = 24.75
    expected = {"paved_width_m": 17.25, "platform_width_m": 19.25, "total_width_m": 24.75}
    metrics = validate_result(response, straight, "straight asymmetric section", expected)
    assert abs(metrics["union_area_m2"] - 2475.0) < 0.001, metrics
    assert abs(response["route_length_m"] - 100.0) < 1e-9
    left_lane = next(f for f in response["feature_collection"]["features"]
                     if f["properties"].get("lane_index") == 1 and f["properties"]["side"] == "left")
    left_ys = [p[1] for p in left_lane["geometry"]["coordinates"][0]]
    assert min(left_ys) >= ORIGIN[1] - 1e-9 and max(left_ys) > ORIGIN[1], left_ys
    results["straight_100m"] = {**metrics, "engine_elapsed_ms": response["elapsed_ms"], "process_wall_ms": wall}

    # Reverse direction swaps the geographic side of a declared left lane.
    reverse = request([[ORIGIN[0] + 100.0, ORIGIN[1]], [ORIGIN[0], ORIGIN[1]]],
                      section(left_lanes=[4.0], right_lanes=[3.0], median_width=0.0,
                              left_emergency_width=0.0, right_emergency_width=0.0,
                              left_shoulder_width=0.0, right_shoulder_width=0.0,
                              left_slope_width=0.0, right_slope_width=0.0))
    response, wall, _ = invoke(reverse)
    metrics = validate_result(response, reverse, "reverse side semantics",
                              {"paved_width_m": 7.0, "platform_width_m": 7.0, "total_width_m": 7.0})
    reverse_left = next(f for f in response["feature_collection"]["features"]
                        if f["properties"]["side"] == "left")
    reverse_ys = [p[1] for p in reverse_left["geometry"]["coordinates"][0]]
    assert max(reverse_ys) <= ORIGIN[1] + 1e-9 and min(reverse_ys) < ORIGIN[1], reverse_ys
    results["reverse_left_is_south"] = {**metrics, "engine_elapsed_ms": response["elapsed_ms"], "process_wall_ms": wall}

    # One side with zero lanes is a supported one-way cross-section.
    one_side = request([[ORIGIN[0], ORIGIN[1]], [ORIGIN[0] + 100.0, ORIGIN[1]]],
                       section(left_lanes=[], right_lanes=[3.5], median_width=0.0,
                               left_emergency_width=0.0, right_emergency_width=0.0,
                               left_shoulder_width=0.0, right_shoulder_width=0.0,
                               left_slope_width=0.0, right_slope_width=0.0))
    response, wall, _ = invoke(one_side)
    metrics = validate_result(response, one_side, "one sided empty lane list",
                              {"paved_width_m": 3.5, "platform_width_m": 3.5, "total_width_m": 3.5})
    assert all(f["properties"]["side"] == "right" for f in response["feature_collection"]["features"])
    results["one_sided"] = {**metrics, "engine_elapsed_ms": response["elapsed_ms"], "process_wall_ms": wall}

    # Smooth UTM curve with large coordinates and increasing vertex counts.
    benchmarks = []
    for count in (33, 100, 300, 1000, 2000):
        points = arc_points(count)
        payload = request(points, section(left_lanes=[3.5], right_lanes=[3.5], median_width=2.0,
                                          left_emergency_width=0.0, right_emergency_width=0.0,
                                          left_shoulder_width=0.0, right_shoulder_width=0.0,
                                          left_slope_width=2.0, right_slope_width=2.0),
                          route_id=f"curve-{count}")
        response, wall, _ = invoke(payload)
        metrics = validate_result(response, payload, f"smooth UTM curve {count}",
                                  {"paved_width_m": 7.0, "platform_width_m": 9.0, "total_width_m": 13.0},
                                  check_feature_area=False)
        benchmarks.append({"vertices": count, **metrics, "engine_elapsed_ms": response["elapsed_ms"],
                           "process_wall_ms": wall, "peak_memory_measured": False})
    results["curve_benchmarks"] = benchmarks

    # Invalid request rejection: negative lane width, duplicate vertex,
    # crossing line, and tight hairpin/U-turn.
    invalid_cases = [
        ("negative_width", request([[0.0, 0.0], [100.0, 0.0]], section(left_lanes=[-3.5]))),
        ("duplicate_vertex", request([[0.0, 0.0], [0.0, 0.0], [100.0, 0.0]])),
        ("crossing_route", request([[0.0, 0.0], [100.0, 100.0], [0.0, 100.0], [100.0, 0.0]])),
        ("hairpin", request([[0.0, 0.0], [100.0, 0.0], [0.01, 0.0]])),
        ("both_lane_sides_empty", request([[0.0, 0.0], [100.0, 0.0]],
            section(left_lanes=[], right_lanes=[]))),
    ]
    rejects = {}
    for name, payload in invalid_cases:
        _, wall, error = invoke(payload, expect_success=False)
        rejects[name] = {"rejected": True, "process_wall_ms": wall, "error": error}
    results["invalid_requests"] = rejects

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "engine": str(ENGINE.relative_to(ROOT)),
        "crs": CRS,
        "coordinate_origin": list(ORIGIN),
        "qgis_version": Qgis.QGIS_VERSION,
        "gdal_version": gdal.VersionInfo("--version"),
        "geos_version": ".".join(str(v) for v in (ogr.GetGEOSVersionMajor(), ogr.GetGEOSVersionMinor(), ogr.GetGEOSVersionMicro())),
        "proj_version": ".".join(str(v) for v in (osr.GetPROJVersionMajor(), osr.GetPROJVersionMinor(), osr.GetPROJVersionMicro())),
        "platform": platform.platform(),
        "processor": platform.processor(),
        "python": sys.version.split()[0],
        "memory_note": "Peak memory was not measured; process wall time includes startup and JSON I/O.",
        "results": results,
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"status": "passed", "report": str(REPORT), "results": results}, indent=2))


if __name__ == "__main__":
    main()
