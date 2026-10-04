use geo::{algorithm::Area, BooleanOps, Coord, LineString, Polygon};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::time::Instant;

mod scene;

const RULE_VERSION: &str = "0.1.0";
const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_COMPONENTS: usize = 64;
const MAX_TOTAL_WIDTH_M: f64 = 200.0;
const EPS: f64 = 1.0e-9;
const MAX_LOCAL_LOOP_OFFSET_FACTOR: f64 = 4.0;
const MAX_LOCAL_LOOP_SOURCE_SEGMENTS: usize = 8;
const MAX_INNER_MITER_RATIO: f64 = 8.0;
const OUTER_ROUND_JOIN_MITER_RATIO: f64 = 2.0;
const ROUND_JOIN_SEGMENTS_PER_QUADRANT: usize = 8;
pub(crate) const OFFSET_GEOMETRY_RULE_VERSION: &str = "offset-local-loops-v3-outer-round-join";

#[derive(Debug, Deserialize)]
struct Request {
    route_id: String,
    points: Vec<[f64; 2]>,
    #[serde(default)]
    crs: Option<String>,
    #[serde(default)]
    source: Option<String>,
    section: Section,
    #[serde(default)]
    scene_options: scene::SceneOptions,
}

#[derive(Debug, Deserialize)]
struct Section {
    left_lanes: Vec<f64>,
    right_lanes: Vec<f64>,
    median_width: f64,
    left_emergency_width: f64,
    right_emergency_width: f64,
    left_shoulder_width: f64,
    right_shoulder_width: f64,
    left_slope_width: f64,
    right_slope_width: f64,
}

struct Component {
    component: &'static str,
    side: &'static str,
    lane_index: Option<usize>,
    width: f64,
    inner: f64,
    outer: f64,
}

#[derive(Debug)]
pub(crate) struct OffsetLine {
    pub(crate) coordinates: Vec<[f64; 2]>,
    pub(crate) stations: Vec<f64>,
    source_points: Vec<usize>,
    pub(crate) rounded_join_count: usize,
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--stream") {
        let stdin = io::stdin();
        let stdout = io::stdout();
        if let Err(error) = process_stream(stdin.lock(), stdout.lock()) {
            eprintln!("road-geometry-engine: stream I/O failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    let result = run();
    match result {
        Ok(response) => println!("{}", response),
        Err(error) => {
            eprintln!("road-geometry-engine: {error}");
            std::process::exit(1);
        }
    }
}

fn process_stream<R: BufRead, W: Write>(mut reader: R, mut writer: W) -> io::Result<()> {
    let mut line = Vec::new();
    while let Some(too_large) = read_stream_line(&mut reader, &mut line)? {
        let envelope = if too_large {
            json!({"error": format!("request line exceeds {MAX_INPUT_BYTES} bytes")})
        } else {
            let result = serde_json::from_slice::<Request>(&line)
                .map_err(|error| format!("invalid request JSON: {error}"))
                .and_then(|request| generate(request, Instant::now()));
            match result {
                Ok(response) => json!({"response": response}),
                Err(error) => json!({"error": error}),
            }
        };
        serde_json::to_writer(&mut writer, &envelope)?;
        writer.write_all(b"\n")?;
    }
    writer.flush()
}

// 只保留单行请求上限内的字节；超限后持续消费到换行，避免污染下一条请求。
fn read_stream_line<R: BufRead>(reader: &mut R, output: &mut Vec<u8>) -> io::Result<Option<bool>> {
    output.clear();
    let mut too_large = false;
    let mut saw_bytes = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(saw_bytes.then_some(too_large));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content_len = newline.unwrap_or(consumed);
        saw_bytes = true;
        if !too_large {
            let remaining = MAX_INPUT_BYTES.saturating_sub(output.len());
            if content_len > remaining {
                too_large = true;
                output.clear();
            } else {
                output.extend_from_slice(&available[..content_len]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            if output.last() == Some(&b'\r') {
                output.pop();
            }
            return Ok(Some(too_large));
        }
    }
}

fn run() -> Result<Value, String> {
    let started = Instant::now();
    let mut input = Vec::new();
    io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|e| format!("failed to read stdin: {e}"))?;
    if input.len() > MAX_INPUT_BYTES {
        return Err(format!("input exceeds {MAX_INPUT_BYTES} bytes"));
    }
    let request: Request =
        serde_json::from_slice(&input).map_err(|e| format!("invalid request JSON: {e}"))?;
    let response = generate(request, started)?;
    Ok(response)
}

fn generate(request: Request, started: Instant) -> Result<Value, String> {
    if request.route_id.trim().is_empty() {
        return Err("route_id must not be empty".into());
    }
    if request.points.len() < 2 {
        return Err("points must contain at least two coordinates".into());
    }
    let mut points = Vec::with_capacity(request.points.len());
    for (i, point) in request.points.iter().enumerate() {
        if !point[0].is_finite() || !point[1].is_finite() {
            return Err(format!(
                "points[{i}] must contain finite projected coordinates"
            ));
        }
        let coord = Coord {
            x: point[0],
            y: point[1],
        };
        if points
            .last()
            .is_some_and(|p: &Coord| distance(*p, coord) <= EPS)
        {
            return Err(format!("points[{i}] duplicates the preceding point"));
        }
        points.push(coord);
    }
    let route_coordinates: Vec<[f64; 2]> = points.iter().map(|point| [point.x, point.y]).collect();
    let mut cumulative = Vec::with_capacity(points.len());
    cumulative.push(0.0);
    for pair in points.windows(2) {
        cumulative.push(cumulative.last().copied().unwrap() + distance(pair[0], pair[1]));
    }
    if let Some(intersection) = first_self_intersection(&route_coordinates, false) {
        let (station_start, station_end) = intersection_stations(intersection, &cumulative);
        return Err(format!(
            "reference route self-intersects between source segments {} and {} near estimated geometric mileages {station_start:.3}m and {station_end:.3}m",
            intersection.first_segment, intersection.second_segment,
        ));
    }

    let scene_options = request.scene_options;
    let section = request.section;
    validate_widths(&section)?;
    let source = request
        .source
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "unknown".into());
    let crs = request
        .crs
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            "crs is required and must identify the projected metric coordinates".to_string()
        })?;
    validate_projected_crs(&crs)?;

    let left_lane_sum: f64 = section.left_lanes.iter().sum();
    let right_lane_sum: f64 = section.right_lanes.iter().sum();
    let paved_width = left_lane_sum
        + right_lane_sum
        + section.left_emergency_width
        + section.right_emergency_width
        + section.left_shoulder_width
        + section.right_shoulder_width;
    let platform_width = paved_width + section.median_width;
    let total_width = platform_width + section.left_slope_width + section.right_slope_width;
    if !total_width.is_finite() || total_width <= 0.0 {
        return Err("total section width must be finite and greater than zero".into());
    }
    if total_width > MAX_TOTAL_WIDTH_M {
        return Err(format!(
            "total section width exceeds the limit of {MAX_TOTAL_WIDTH_M}m"
        ));
    }

    let mut components = Vec::new();
    if section.median_width > 0.0 {
        components.push(Component {
            component: "median",
            side: "center",
            lane_index: None,
            width: section.median_width,
            inner: -section.median_width / 2.0,
            outer: section.median_width / 2.0,
        });
    }
    add_side(
        &mut components,
        &section.left_lanes,
        "left",
        section.median_width / 2.0,
    )?;
    add_side(
        &mut components,
        &section.right_lanes,
        "right",
        section.median_width / 2.0,
    )?;
    add_band(
        &mut components,
        "emergency",
        "left",
        section.left_emergency_width,
        left_lane_sum + section.median_width / 2.0,
    );
    add_band(
        &mut components,
        "emergency",
        "right",
        section.right_emergency_width,
        right_lane_sum + section.median_width / 2.0,
    );
    add_band(
        &mut components,
        "shoulder",
        "left",
        section.left_shoulder_width,
        left_lane_sum + section.median_width / 2.0 + section.left_emergency_width,
    );
    add_band(
        &mut components,
        "shoulder",
        "right",
        section.right_shoulder_width,
        right_lane_sum + section.median_width / 2.0 + section.right_emergency_width,
    );
    add_band(
        &mut components,
        "slope",
        "left",
        section.left_slope_width,
        left_lane_sum
            + section.median_width / 2.0
            + section.left_emergency_width
            + section.left_shoulder_width,
    );
    add_band(
        &mut components,
        "slope",
        "right",
        section.right_slope_width,
        right_lane_sum
            + section.median_width / 2.0
            + section.right_emergency_width
            + section.right_shoulder_width,
    );
    if components.is_empty() {
        return Err("section must contain at least one non-zero width".into());
    }
    if components.len() > MAX_COMPONENTS {
        return Err(format!(
            "component count exceeds the limit of {MAX_COMPONENTS}"
        ));
    }

    let mut boundaries: Vec<f64> = components.iter().flat_map(|c| [c.inner, c.outer]).collect();
    boundaries.sort_by(f64::total_cmp);
    boundaries.dedup_by(|a, b| *a == *b);
    let mut offsets = Vec::with_capacity(boundaries.len());
    let mut geometry_warnings = Vec::new();
    for offset in boundaries {
        let (line, repair) = offset_line_with_local_repair(&points, offset, &cumulative)?;
        if line.rounded_join_count > 0 {
            geometry_warnings.push(offset_round_join_warning(offset, line.rounded_join_count));
        }
        if let Some(repair) = repair {
            geometry_warnings.push(offset_repair_warning(offset, repair));
        }
        offsets.push((offset, line.coordinates));
    }

    let generated = components
        .iter()
        .map(|component| {
            let inner = find_offset(&offsets, component.inner);
            let outer = find_offset(&offsets, component.outer);
            let ring = band_polygon(inner, outer);
            if ring.len() < 4 || polygon_self_intersects(&ring) {
                return Err(format!(
                    "generated {} {} geometry is self-intersecting or degenerate",
                    component.component, component.side
                ));
            }
            let polygon = Polygon::new(
                LineString::new(ring.iter().map(|p| Coord { x: p[0], y: p[1] }).collect()),
                vec![],
            );
            if polygon.unsigned_area() <= EPS {
                return Err(format!(
                    "generated {} {} polygon is invalid",
                    component.component, component.side
                ));
            }
            let mut properties = json!({
                "route_id": request.route_id,
                "component": component.component,
                "side": component.side,
                "width_m": component.width,
                "source": source,
                "width_unit": "m",
                "rule_version": RULE_VERSION,
                "geometry_rule_version": OFFSET_GEOMETRY_RULE_VERSION
            });
            if let Some(index) = component.lane_index {
                properties["lane_index"] = json!(index);
                properties["lane_width_m"] = json!(component.width);
            }
            properties["left_lane_count"] = json!(section.left_lanes.len());
            properties["right_lane_count"] = json!(section.right_lanes.len());
            if component.side == "left" {
                properties["lane_count"] = json!(section.left_lanes.len());
            } else if component.side == "right" {
                properties["lane_count"] = json!(section.right_lanes.len());
            }
            let feature = json!({
                "type": "Feature",
                "geometry": { "type": "Polygon", "coordinates": [ring] },
                "properties": properties
            });
            Ok((feature, polygon))
        })
        .collect::<Result<Vec<_>, String>>()?;

    for i in 0..generated.len() {
        for j in (i + 1)..generated.len() {
            let overlap_area = generated[i].1.intersection(&generated[j].1).unsigned_area();
            if overlap_area > EPS {
                return Err(format!(
                    "generated {} and {} geometries overlap by {overlap_area} square metres",
                    components[i].component, components[j].component
                ));
            }
        }
    }
    let features: Vec<Value> = generated.into_iter().map(|(feature, _)| feature).collect();

    let length = points
        .windows(2)
        .map(|pair| distance(pair[0], pair[1]))
        .sum::<f64>();
    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let mut response = json!({
        "feature_collection": { "type": "FeatureCollection", "features": features },
        "route_length_m": length,
        "paved_width_m": paved_width,
        "platform_width_m": platform_width,
        "total_width_m": total_width,
        "left_lane_count": section.left_lanes.len(),
        "right_lane_count": section.right_lanes.len(),
        "left_lane_widths_m": section.left_lanes,
        "right_lane_widths_m": section.right_lanes,
        "feature_count": features.len(),
        "elapsed_ms": elapsed_ms,
        "warnings": [],
        "geometry_warnings": geometry_warnings,
        "geometry_rule_version": OFFSET_GEOMETRY_RULE_VERSION
    });
    response["projected_crs"] = json!(crs);
    let (ancillary_layers, ancillary_warnings) = scene::build_ancillary_layers(
        &request.route_id,
        &points,
        &section,
        &scene_options,
        &source,
        &crs,
    )?;
    for warning in ancillary_warnings {
        let duplicate = geometry_warnings.iter().any(|existing| {
            existing["code"] == warning["code"]
                && existing["offset_m"] == warning["offset_m"]
                && existing["source_point_start"] == warning["source_point_start"]
                && existing["source_point_end"] == warning["source_point_end"]
        });
        if !duplicate {
            geometry_warnings.push(warning);
        }
    }
    response["geometry_warnings"] = json!(geometry_warnings);
    response["ancillary_layers"] = json!(ancillary_layers);
    Ok(response)
}

fn validate_widths(section: &Section) -> Result<(), String> {
    for (name, values) in [
        ("left_lanes", section.left_lanes.as_slice()),
        ("right_lanes", section.right_lanes.as_slice()),
    ] {
        for (i, width) in values.iter().enumerate() {
            if !width.is_finite() || *width <= 0.0 {
                return Err(format!(
                    "section.{name}[{i}] must be finite and greater than zero"
                ));
            }
        }
    }
    if section.left_lanes.is_empty() && section.right_lanes.is_empty() {
        return Err("section must contain lanes on at least one side".into());
    }
    for (name, width) in [
        ("median_width", section.median_width),
        ("left_emergency_width", section.left_emergency_width),
        ("right_emergency_width", section.right_emergency_width),
        ("left_shoulder_width", section.left_shoulder_width),
        ("right_shoulder_width", section.right_shoulder_width),
        ("left_slope_width", section.left_slope_width),
        ("right_slope_width", section.right_slope_width),
    ] {
        if !width.is_finite() || width < 0.0 {
            return Err(format!("section.{name} must be finite and non-negative"));
        }
    }
    if section.left_lanes.len() + section.right_lanes.len() + 7 > MAX_COMPONENTS {
        return Err(format!(
            "section exceeds the limit of {MAX_COMPONENTS} components"
        ));
    }
    Ok(())
}

fn validate_projected_crs(crs: &str) -> Result<(), String> {
    let normalized = crs.to_ascii_uppercase().replace(' ', "");
    if [
        "EPSG:4326",
        "EPSG:4490",
        "EPSG:4269",
        "EPSG:3857",
        "CRS:84",
        "OGC:CRS84",
    ]
    .contains(&normalized.as_str())
    {
        return Err(format!(
            "crs {crs:?} is geographic or unsuitable for metric geometry; provide a suitable projected CRS and metric coordinates"
        ));
    }
    Ok(())
}

fn add_side(
    components: &mut Vec<Component>,
    lanes: &[f64],
    side: &'static str,
    start: f64,
) -> Result<(), String> {
    let mut distance = start;
    for (index, width) in lanes.iter().copied().enumerate() {
        let outer = distance + width;
        components.push(Component {
            component: "lane",
            side,
            lane_index: Some(index + 1),
            width,
            inner: signed(side, distance),
            outer: signed(side, outer),
        });
        distance = outer;
    }
    Ok(())
}

fn add_band(
    components: &mut Vec<Component>,
    kind: &'static str,
    side: &'static str,
    width: f64,
    start: f64,
) {
    if width > 0.0 {
        components.push(Component {
            component: kind,
            side,
            lane_index: None,
            width,
            inner: signed(side, start),
            outer: signed(side, start + width),
        });
    }
}

fn signed(side: &str, distance: f64) -> f64 {
    if side == "left" {
        distance
    } else {
        -distance
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct LocalLoopRepair {
    pub(crate) source_point_start: usize,
    pub(crate) source_point_end: usize,
    pub(crate) station_start_m: f64,
    pub(crate) station_end_m: f64,
    pub(crate) crossing: [f64; 2],
    pub(crate) crossing_index: usize,
}

pub(crate) fn offset_line_with_local_repair(
    points: &[Coord],
    offset: f64,
    cumulative: &[f64],
) -> Result<(OffsetLine, Option<LocalLoopRepair>), String> {
    let output = offset_line_vertices(points, offset, cumulative)?;
    repair_offset_line(output, offset, cumulative)
}

fn repair_offset_line(
    output: OffsetLine,
    offset: f64,
    cumulative: &[f64],
) -> Result<(OffsetLine, Option<LocalLoopRepair>), String> {
    let Some(intersection) = first_self_intersection(&output.coordinates, false) else {
        return Ok((output, None));
    };
    let first = intersection.first_segment;
    let second = intersection.second_segment;
    let first_source = output.source_points[first];
    let second_source = output.source_points[second];
    let local_limit = offset.abs() * MAX_LOCAL_LOOP_OFFSET_FACTOR;
    let (station_start, station_end) = intersection_stations(intersection, &output.stations);
    let source_span = cumulative
        .get(second_source + 1)
        .zip(cumulative.get(first_source))
        .map(|(end, start)| end - start)
        .unwrap_or(f64::INFINITY);
    if intersection.crossing.is_none()
        || offset.abs() <= EPS
        || second_source.saturating_sub(first_source) > MAX_LOCAL_LOOP_SOURCE_SEGMENTS
        || !source_span.is_finite()
        || source_span < -EPS
        || source_span > local_limit
    {
        return Err(format!(
            "offset boundary at {offset}m self-intersects between source segments {first_source} and {second_source} near estimated geometric mileages {station_start:.3}m and {station_end:.3}m; outside the local repair limit"
        ));
    }

    let crossing = intersection.crossing.unwrap();
    let crossing_index = first + 1;
    let mut repaired = OffsetLine {
        coordinates: Vec::with_capacity(output.coordinates.len() - (second - first)),
        stations: Vec::with_capacity(output.stations.len() - (second - first)),
        source_points: Vec::with_capacity(output.source_points.len() - (second - first)),
        rounded_join_count: output.rounded_join_count,
    };
    repaired
        .coordinates
        .extend_from_slice(&output.coordinates[..=first]);
    repaired.coordinates.push(crossing.point);
    repaired
        .coordinates
        .extend_from_slice(&output.coordinates[second + 1..]);
    repaired
        .stations
        .extend_from_slice(&output.stations[..=first]);
    repaired.stations.push(station_start);
    repaired
        .stations
        .extend_from_slice(&output.stations[second + 1..]);
    repaired
        .source_points
        .extend_from_slice(&output.source_points[..=first]);
    repaired.source_points.push(first_source);
    repaired
        .source_points
        .extend_from_slice(&output.source_points[second + 1..]);
    if let Some(remaining) = first_self_intersection(&repaired.coordinates, false) {
        return Err(format!(
            "offset boundary at {offset}m still self-intersects between repaired segments {} and {} after local loop trimming (source segments {first_source} and {second_source})",
            remaining.first_segment, remaining.second_segment
        ));
    }

    Ok((
        repaired,
        Some(LocalLoopRepair {
            source_point_start: first_source,
            source_point_end: second_source + 1,
            station_start_m: station_start,
            station_end_m: station_end,
            crossing: crossing.point,
            crossing_index,
        }),
    ))
}

pub(crate) fn offset_repair_warning(offset: f64, repair: LocalLoopRepair) -> Value {
    json!({
        "code": "offset_local_loop_trimmed",
        "rule_version": OFFSET_GEOMETRY_RULE_VERSION,
        "offset_m": offset,
        "source_point_start": repair.source_point_start,
        "source_point_end": repair.source_point_end,
        "station_start_m": repair.station_start_m,
        "station_end_m": repair.station_end_m,
        "message": "局部偏移回环已按精确交点修剪；所列桩号为源路线几何累计里程估算，修复区间需人工复核"
    })
}

pub(crate) fn offset_round_join_warning(offset: f64, join_count: usize) -> Value {
    json!({
        "code": "offset_outer_round_join",
        "rule_version": OFFSET_GEOMETRY_RULE_VERSION,
        "offset_m": offset,
        "join_style": "round",
        "join_policy": "outer_only",
        "miter_trigger_ratio": OUTER_ROUND_JOIN_MITER_RATIO,
        "join_count": join_count,
        "message": format!("外侧偏移边界有 {join_count} 处转角按圆弧连接；触发条件为 miter 比例超过 {}，内侧保持 {} 的 miter 上限", OUTER_ROUND_JOIN_MITER_RATIO, MAX_INNER_MITER_RATIO)
    })
}

fn intersection_stations(intersection: SelfIntersection, stations: &[f64]) -> (f64, f64) {
    let first = intersection.first_segment;
    let second = intersection.second_segment;
    if let Some(crossing) = intersection.crossing {
        (
            stations[first] + (stations[first + 1] - stations[first]) * crossing.first_fraction,
            stations[second] + (stations[second + 1] - stations[second]) * crossing.second_fraction,
        )
    } else {
        (stations[first], stations[second + 1])
    }
}

fn offset_line_vertices(
    points: &[Coord],
    offset: f64,
    cumulative: &[f64],
) -> Result<OffsetLine, String> {
    if points.len() != cumulative.len() {
        return Err("offset line source stations do not match its vertices".into());
    }
    if offset.abs() <= EPS {
        return Ok(OffsetLine {
            coordinates: points.iter().map(|point| [point.x, point.y]).collect(),
            stations: cumulative.to_vec(),
            source_points: (0..points.len()).collect(),
            rounded_join_count: 0,
        });
    }

    let mut output = OffsetLine {
        coordinates: Vec::with_capacity(points.len()),
        stations: Vec::with_capacity(points.len()),
        source_points: Vec::with_capacity(points.len()),
        rounded_join_count: 0,
    };
    for i in 0..points.len() {
        let prev = if i > 0 {
            Some(unit_normal(points[i - 1], points[i])?)
        } else {
            None
        };
        let next = if i + 1 < points.len() {
            Some(unit_normal(points[i], points[i + 1])?)
        } else {
            None
        };
        let append = |line: &mut OffsetLine, point: [f64; 2]| -> Result<(), String> {
            let x = points[i].x + point[0];
            let y = points[i].y + point[1];
            if !x.is_finite() || !y.is_finite() {
                return Err("offset geometry contains non-finite coordinates".into());
            }
            line.coordinates.push([x, y]);
            line.stations.push(cumulative[i]);
            line.source_points.push(i);
            Ok(())
        };
        match (prev, next) {
            (None, Some(n)) | (Some(n), None) => {
                append(&mut output, [n[0] * offset, n[1] * offset])?
            }
            (Some(a), Some(b)) => {
                let sx = a[0] + b[0];
                let sy = a[1] + b[1];
                let norm = (sx * sx + sy * sy).sqrt();
                if norm < 1.0e-8 {
                    return Err(format!("route has a U-turn near point {i}"));
                }
                let mx = sx / norm;
                let my = sy / norm;
                let denom = mx * b[0] + my * b[1];
                let turn = a[0] * b[1] - a[1] * b[0];
                let miter_ratio = if denom.abs() <= EPS {
                    f64::INFINITY
                } else {
                    1.0 / denom.abs()
                };
                if turn * offset < 0.0 {
                    if miter_ratio > OUTER_ROUND_JOIN_MITER_RATIO {
                        append_round_join(&mut output, points[i], i, cumulative[i], a, b, offset)?;
                        output.rounded_join_count += 1;
                    } else {
                        let scale = offset / denom;
                        append(&mut output, [mx * scale, my * scale])?;
                    }
                } else if miter_ratio > MAX_INNER_MITER_RATIO {
                    return Err(format!(
                        "route turn near point {i} exceeds the inner-side miter limit"
                    ));
                } else {
                    let scale = offset / denom;
                    append(&mut output, [mx * scale, my * scale])?;
                }
            }
            (None, None) => unreachable!(),
        }
    }
    Ok(output)
}

fn append_round_join(
    output: &mut OffsetLine,
    center: Coord,
    source_point: usize,
    station: f64,
    previous_normal: [f64; 2],
    next_normal: [f64; 2],
    offset: f64,
) -> Result<(), String> {
    let start = [previous_normal[0] * offset, previous_normal[1] * offset];
    let end = [next_normal[0] * offset, next_normal[1] * offset];
    let cross = start[0] * end[1] - start[1] * end[0];
    let dot = start[0] * end[0] + start[1] * end[1];
    let sweep = cross.atan2(dot);
    let segments = ((sweep.abs() / std::f64::consts::FRAC_PI_2)
        * ROUND_JOIN_SEGMENTS_PER_QUADRANT as f64)
        .ceil()
        .max(1.0) as usize;
    let radius = offset.abs();
    let start_angle = start[1].atan2(start[0]);

    for step in 0..=segments {
        let relative = step as f64 / segments as f64;
        let point = if step == 0 {
            start
        } else if step == segments {
            end
        } else {
            let angle = start_angle + sweep * relative;
            [radius * angle.cos(), radius * angle.sin()]
        };
        let x = center.x + point[0];
        let y = center.y + point[1];
        if !x.is_finite() || !y.is_finite() {
            return Err("round offset join contains non-finite coordinates".into());
        }
        output.coordinates.push([x, y]);
        output.stations.push(station);
        output.source_points.push(source_point);
    }
    Ok(())
}

fn unit_normal(a: Coord, b: Coord) -> Result<[f64; 2], String> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let length = (dx * dx + dy * dy).sqrt();
    if length <= EPS {
        return Err("route contains a zero-length segment".into());
    }
    Ok([-dy / length, dx / length])
}

fn band_polygon(inner: &[[f64; 2]], outer: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut ring = inner.to_vec();
    ring.extend(outer.iter().rev().copied());
    ring.push(ring[0]);
    ring
}

fn find_offset(offsets: &[(f64, Vec<[f64; 2]>)], value: f64) -> &[[f64; 2]] {
    &offsets
        .iter()
        .find(|(offset, _)| *offset == value)
        .expect("all boundaries were generated")
        .1
}

fn distance(a: Coord, b: Coord) -> f64 {
    ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt()
}

fn polygon_self_intersects(ring: &[[f64; 2]]) -> bool {
    segments_self_intersect(ring, true)
}

#[derive(Clone, Copy)]
struct SelfIntersection {
    first_segment: usize,
    second_segment: usize,
    crossing: Option<SegmentCrossing>,
}

#[derive(Clone, Copy)]
struct SegmentCrossing {
    point: [f64; 2],
    first_fraction: f64,
    second_fraction: f64,
}

#[derive(Clone, Copy)]
struct SegmentBounds {
    index: usize,
    a: [f64; 2],
    b: [f64; 2],
    min_scan: f64,
    max_scan: f64,
    min_cross: f64,
    max_cross: f64,
}

// 沿整体跨度较大的坐标轴扫描，避免横向或纵向长路线退化为全量两两相交。
fn segments_self_intersect(points: &[[f64; 2]], closed: bool) -> bool {
    first_self_intersection(points, closed).is_some()
}

fn first_self_intersection(points: &[[f64; 2]], closed: bool) -> Option<SelfIntersection> {
    let segment_count = points.len().saturating_sub(1);
    let first = points.first()?;
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (first[0], first[0], first[1], first[1]);
    for point in &points[1..] {
        min_x = min_x.min(point[0]);
        max_x = max_x.max(point[0]);
        min_y = min_y.min(point[1]);
        max_y = max_y.max(point[1]);
    }
    let scan_y = max_y - min_y > max_x - min_x;
    let (scan_axis, cross_axis) = if scan_y { (1, 0) } else { (0, 1) };
    let mut segments = Vec::with_capacity(segment_count);
    for index in 0..segment_count {
        let a = points[index];
        let b = points[index + 1];
        segments.push(SegmentBounds {
            index,
            a,
            b,
            min_scan: a[scan_axis].min(b[scan_axis]),
            max_scan: a[scan_axis].max(b[scan_axis]),
            min_cross: a[cross_axis].min(b[cross_axis]),
            max_cross: a[cross_axis].max(b[cross_axis]),
        });
    }
    segments.sort_by(|a, b| a.min_scan.total_cmp(&b.min_scan));

    let mut active: Vec<SegmentBounds> = Vec::new();
    for segment in segments {
        active.retain(|candidate| candidate.max_scan + EPS >= segment.min_scan);
        for candidate in &active {
            let first_segment = candidate.index.min(segment.index);
            let second_segment = candidate.index.max(segment.index);
            let adjacent = second_segment - first_segment <= 1;
            let ring_closure = closed && first_segment == 0 && second_segment + 1 == segment_count;
            if adjacent || ring_closure {
                continue;
            }
            if candidate.max_cross + EPS < segment.min_cross
                || segment.max_cross + EPS < candidate.min_cross
                || !segments_intersect(candidate.a, candidate.b, segment.a, segment.b)
            {
                continue;
            }
            return Some(SelfIntersection {
                first_segment,
                second_segment,
                crossing: if candidate.index == first_segment {
                    segment_intersection(candidate.a, candidate.b, segment.a, segment.b)
                } else {
                    segment_intersection(segment.a, segment.b, candidate.a, candidate.b)
                },
            });
        }
        active.push(segment);
    }
    None
}

fn segment_intersection(
    a: [f64; 2],
    b: [f64; 2],
    c: [f64; 2],
    d: [f64; 2],
) -> Option<SegmentCrossing> {
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let denominator = r[0] * s[1] - r[1] * s[0];
    if denominator.abs() <= EPS {
        return None;
    }
    let q = [c[0] - a[0], c[1] - a[1]];
    let t = (q[0] * s[1] - q[1] * s[0]) / denominator;
    let u = (q[0] * r[1] - q[1] * r[0]) / denominator;
    if !(-EPS..=1.0 + EPS).contains(&t) || !(-EPS..=1.0 + EPS).contains(&u) {
        return None;
    }
    let point = [a[0] + t * r[0], a[1] + t * r[1]];
    point
        .iter()
        .all(|coordinate| coordinate.is_finite())
        .then_some(SegmentCrossing {
            point,
            first_fraction: t.clamp(0.0, 1.0),
            second_fraction: u.clamp(0.0, 1.0),
        })
}

fn segments_intersect(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let orient = |p: [f64; 2], q: [f64; 2], r: [f64; 2]| {
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    };
    let ab_c = orient(a, b, c);
    let ab_d = orient(a, b, d);
    let cd_a = orient(c, d, a);
    let cd_b = orient(c, d, b);
    ab_c * ab_d <= EPS
        && cd_a * cd_b <= EPS
        && a[0].max(b[0]) + EPS >= c[0].min(d[0])
        && c[0].max(d[0]) + EPS >= a[0].min(b[0])
        && a[1].max(b[1]) + EPS >= c[1].min(d[1])
        && c[1].max(d[1]) + EPS >= a[1].min(b[1])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn request(points: Vec<[f64; 2]>) -> Request {
        Request {
            route_id: "R1".into(),
            points,
            crs: Some("EPSG:32610".into()),
            source: Some("survey".into()),
            scene_options: scene::SceneOptions::default(),
            section: Section {
                left_lanes: vec![3.5, 3.5],
                right_lanes: vec![3.5, 3.5],
                median_width: 2.0,
                left_emergency_width: 1.0,
                right_emergency_width: 1.0,
                left_shoulder_width: 1.0,
                right_shoulder_width: 1.0,
                left_slope_width: 2.0,
                right_slope_width: 2.0,
            },
        }
    }

    fn encoded_request(points: Vec<[f64; 2]>) -> String {
        serde_json::to_string(&json!({
            "route_id": "R1",
            "points": points,
            "crs": "EPSG:32610",
            "source": "survey",
            "section": {
                "left_lanes": [3.5, 3.5],
                "right_lanes": [3.5, 3.5],
                "median_width": 2.0,
                "left_emergency_width": 1.0,
                "right_emergency_width": 1.0,
                "left_shoulder_width": 1.0,
                "right_shoulder_width": 1.0,
                "left_slope_width": 2.0,
                "right_slope_width": 2.0
            }
        }))
        .unwrap()
    }

    #[test]
    fn straight_has_expected_width_area_and_adjacency() {
        let result = generate(request(vec![[0.0, 0.0], [100.0, 0.0]]), Instant::now()).unwrap();
        assert_eq!(result["feature_count"], 11);
        assert_eq!(result["route_length_m"], 100.0);
        assert_eq!(result["paved_width_m"], 18.0);
        assert_eq!(result["platform_width_m"], 20.0);
        assert_eq!(result["total_width_m"], 24.0);
        assert_eq!(result["left_lane_count"], 2);
        assert_eq!(result["right_lane_count"], 2);
        assert_eq!(result["left_lane_widths_m"], json!([3.5, 3.5]));
        assert_eq!(result["right_lane_widths_m"], json!([3.5, 3.5]));
        let features = result["feature_collection"]["features"].as_array().unwrap();
        assert_eq!(features[1]["properties"]["lane_count"], 2);
        assert_eq!(features[1]["properties"]["lane_width_m"], 3.5);
        assert_eq!(features[1]["properties"]["left_lane_count"], 2);
        assert_eq!(features[1]["properties"]["right_lane_count"], 2);
        assert_eq!(
            features[1]["properties"]["geometry_rule_version"],
            OFFSET_GEOMETRY_RULE_VERSION
        );
        let lane = &features[1]["geometry"]["coordinates"][0];
        let ring: Vec<[f64; 2]> = serde_json::from_value(lane.clone()).unwrap();
        assert_eq!(polygon_area(&ring), 350.0);
        // Shared lane boundaries are constructed from the same offset coordinates.
        assert_eq!(ring[1][1], 1.0);
        assert_eq!(ring[2][1], 4.5);
    }

    #[test]
    fn asymmetric_widths_are_reported_and_direction_defines_left() {
        let mut req = request(vec![[0.0, 0.0], [10.0, 0.0]]);
        req.section.left_lanes = vec![4.0];
        req.section.right_lanes = vec![3.0];
        req.section.left_emergency_width = 0.0;
        req.section.right_emergency_width = 0.0;
        req.section.left_shoulder_width = 0.0;
        req.section.right_shoulder_width = 0.0;
        req.section.left_slope_width = 0.0;
        req.section.right_slope_width = 0.0;
        let forward = generate(req, Instant::now()).unwrap();
        assert_eq!(forward["paved_width_m"], 7.0);
        assert_eq!(forward["platform_width_m"], 9.0);
        assert_eq!(forward["total_width_m"], 9.0);
        let mut reversed = request(vec![[10.0, 0.0], [0.0, 0.0]]);
        reversed.section.left_lanes = vec![4.0];
        reversed.section.right_lanes = vec![3.0];
        reversed.section.median_width = 0.0;
        reversed.section.left_emergency_width = 0.0;
        reversed.section.right_emergency_width = 0.0;
        reversed.section.left_shoulder_width = 0.0;
        reversed.section.right_shoulder_width = 0.0;
        reversed.section.left_slope_width = 0.0;
        reversed.section.right_slope_width = 0.0;
        let back = generate(reversed, Instant::now()).unwrap();
        let reverse_ring = &back["feature_collection"]["features"][0]["geometry"]["coordinates"][0];
        assert_eq!(reverse_ring[2][1], -4.0);
    }

    #[test]
    fn ordinary_curve_creates_valid_polygons() {
        let result = generate(
            request(vec![[0.0, 0.0], [20.0, 0.0], [40.0, 10.0], [60.0, 20.0]]),
            Instant::now(),
        );
        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn sharp_outer_turn_rounds_with_mapped_station_and_shared_lane_edge() {
        let route: Vec<Coord> = [[0.0, 0.0], [10.0, 0.0], [0.2, 1.7]]
            .into_iter()
            .map(|point| Coord {
                x: point[0],
                y: point[1],
            })
            .collect();
        let mut cumulative = vec![0.0];
        for pair in route.windows(2) {
            cumulative.push(cumulative.last().copied().unwrap() + distance(pair[0], pair[1]));
        }
        let original_route = route.clone();
        let rounded = offset_line_vertices(&route, -3.0, &cumulative).unwrap();
        assert_eq!(route, original_route);
        assert!(rounded.coordinates.len() > route.len());
        assert_eq!(rounded.coordinates.len(), rounded.stations.len());
        assert_eq!(rounded.coordinates.len(), rounded.source_points.len());
        let join = &rounded.coordinates[1..rounded.coordinates.len() - 1];
        assert!(join.iter().all(|point| {
            (((point[0] - route[1].x).powi(2) + (point[1] - route[1].y).powi(2)).sqrt() - 3.0).abs()
                < 1.0e-9
        }));
        assert!(rounded.stations[1..rounded.stations.len() - 1]
            .iter()
            .all(|station| *station == cumulative[1]));
        assert!(rounded.source_points[1..rounded.source_points.len() - 1]
            .iter()
            .all(|source_point| *source_point == 1));
        assert!(offset_line_vertices(&route, 3.0, &cumulative)
            .unwrap_err()
            .contains("inner-side miter limit"));

        let mut req = request(vec![[0.0, 0.0], [10.0, 0.0], [0.2, 1.7]]);
        req.section.left_lanes.clear();
        req.section.right_lanes = vec![2.0, 3.0];
        req.section.median_width = 0.0;
        req.section.left_emergency_width = 0.0;
        req.section.right_emergency_width = 0.0;
        req.section.left_shoulder_width = 0.0;
        req.section.right_shoulder_width = 0.0;
        req.section.left_slope_width = 0.0;
        req.section.right_slope_width = 0.0;
        let result = generate(req, Instant::now()).unwrap();
        let lanes = result["feature_collection"]["features"].as_array().unwrap();
        let first = lanes
            .iter()
            .find(|feature| feature["properties"]["lane_index"] == 1)
            .unwrap();
        let second = lanes
            .iter()
            .find(|feature| feature["properties"]["lane_index"] == 2)
            .unwrap();
        let first_ring: Vec<[f64; 2]> =
            serde_json::from_value(first["geometry"]["coordinates"][0].clone()).unwrap();
        let second_ring: Vec<[f64; 2]> =
            serde_json::from_value(second["geometry"]["coordinates"][0].clone()).unwrap();
        let shared_edge = &first_ring[route.len()..first_ring.len() - 1];
        assert!(shared_edge.len() < second_ring.len());
        assert_eq!(
            shared_edge,
            &second_ring[..shared_edge.len()]
                .iter()
                .rev()
                .copied()
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn moderate_outer_round_join_keeps_full_two_sided_road_generation() {
        let turn = 130.0_f64.to_radians();
        let points = vec![
            [0.0, 0.0],
            [100.0, 0.0],
            [100.0 + 100.0 * turn.cos(), 100.0 * turn.sin()],
        ];
        let mut req = request(points.clone());
        req.scene_options.enabled = vec!["markings".into()];

        let response = generate(req, Instant::now()).unwrap();
        assert_eq!(response["feature_count"], 11);
        assert_eq!(response["left_lane_count"], 2);
        assert_eq!(response["right_lane_count"], 2);

        let route: Vec<Coord> = points
            .iter()
            .map(|point| Coord {
                x: point[0],
                y: point[1],
            })
            .collect();
        let mut cumulative = vec![0.0];
        for pair in route.windows(2) {
            cumulative.push(cumulative.last().copied().unwrap() + distance(pair[0], pair[1]));
        }
        let outer = offset_line_vertices(&route, -12.0, &cumulative).unwrap();
        let inner = offset_line_vertices(&route, 12.0, &cumulative).unwrap();
        assert!(outer.coordinates.len() > route.len());
        assert_eq!(outer.rounded_join_count, 1);
        assert_eq!(inner.coordinates.len(), route.len());
        assert_eq!(inner.rounded_join_count, 0);

        let features = response["feature_collection"]["features"]
            .as_array()
            .unwrap();
        let right_lane_1 = features
            .iter()
            .find(|feature| {
                feature["properties"]["side"] == "right" && feature["properties"]["lane_index"] == 1
            })
            .unwrap();
        let right_lane_2 = features
            .iter()
            .find(|feature| {
                feature["properties"]["side"] == "right" && feature["properties"]["lane_index"] == 2
            })
            .unwrap();
        assert_eq!(right_lane_1["properties"]["width_m"], 3.5);
        assert_eq!(right_lane_2["properties"]["width_m"], 3.5);
        assert_eq!(right_lane_1["properties"]["lane_count"], 2);
        let inner_boundary = offset_line_vertices(&route, -1.0, &cumulative).unwrap();
        let first_ring: Vec<[f64; 2]> =
            serde_json::from_value(right_lane_1["geometry"]["coordinates"][0].clone()).unwrap();
        let second_ring: Vec<[f64; 2]> =
            serde_json::from_value(right_lane_2["geometry"]["coordinates"][0].clone()).unwrap();
        let shared_edge = &first_ring[inner_boundary.coordinates.len()..first_ring.len() - 1];
        assert_eq!(shared_edge.len(), outer.coordinates.len());
        assert_eq!(
            shared_edge,
            &second_ring[..shared_edge.len()]
                .iter()
                .rev()
                .copied()
                .collect::<Vec<_>>()
        );

        let warnings = response["geometry_warnings"].as_array().unwrap();
        let round_warning = warnings
            .iter()
            .find(|warning| warning["code"] == "offset_outer_round_join")
            .unwrap();
        assert_eq!(round_warning["join_style"], "round");
        assert_eq!(round_warning["join_policy"], "outer_only");
        assert_eq!(round_warning["miter_trigger_ratio"], 2.0);
        assert_eq!(round_warning["join_count"], 1);

        let ordinary_route = [
            Coord { x: 0.0, y: 0.0 },
            Coord { x: 10.0, y: 0.0 },
            Coord { x: 10.0, y: 10.0 },
        ];
        let ordinary = offset_line_vertices(&ordinary_route, -3.0, &[0.0, 10.0, 20.0]).unwrap();
        assert_eq!(ordinary.rounded_join_count, 0);
        assert_eq!(ordinary.coordinates.len(), ordinary_route.len());
    }

    #[test]
    fn expanded_round_join_indices_do_not_corrupt_later_loop_stations() {
        let prefix_route: Vec<Coord> = [[0.0, 0.0], [100.0, 0.0], [0.2, -17.0]]
            .into_iter()
            .map(|point| Coord {
                x: point[0],
                y: point[1],
            })
            .collect();
        let prefix_stations = [0.0, 100.0, 201.0];
        let prefix = offset_line_vertices(&prefix_route, 3.0, &prefix_stations).unwrap();
        assert!(prefix.coordinates.len() > prefix_route.len());

        let mut combined = prefix;
        combined.coordinates.push([-500.0, -100.0]);
        combined.stations.push(1_000.0);
        combined.source_points.push(3);
        let loop_points = [
            [1_000.0, 1_000.0],
            [1_010.0, 1_010.0],
            [1_000.0, 1_010.0],
            [1_010.0, 1_000.0],
        ];
        for (index, point) in loop_points.iter().enumerate() {
            combined.coordinates.push(*point);
            combined.stations.push(1_000.0 + index as f64 * 2.0);
            combined.source_points.push(4 + index);
        }
        let source_stations = [0.0, 2.0, 4.0, 1_000.0, 1_000.0, 1_002.0, 1_004.0, 1_006.0];

        let (repaired, Some(repair)) = repair_offset_line(combined, 3.0, &source_stations).unwrap()
        else {
            panic!("expanded input should contain one bounded local loop");
        };
        assert!(repair.crossing_index > prefix_route.len());
        assert_eq!(repair.source_point_start, 4);
        assert_eq!(repair.source_point_end, 7);
        assert!((repair.station_start_m - 1_001.0).abs() < 1.0e-8);
        assert!((repair.station_end_m - 1_005.0).abs() < 1.0e-8);
        assert_eq!(repaired.coordinates.len(), repaired.stations.len());
        assert_eq!(repaired.coordinates.len(), repaired.source_points.len());

        let mut scene_coordinates = repaired.coordinates;
        let mut scene_stations = repaired.stations;
        let duplicate_anchor = repair.crossing_index + 1;
        scene_coordinates.insert(duplicate_anchor, repair.crossing);
        scene_stations.insert(duplicate_anchor, repair.station_end_m);
        assert_eq!(scene_coordinates.len(), scene_stations.len());
        assert_eq!(scene_coordinates[duplicate_anchor - 1], repair.crossing);
        assert_eq!(scene_coordinates[duplicate_anchor], repair.crossing);
        assert_eq!(scene_stations[duplicate_anchor - 1], 1_001.0);
        assert_eq!(scene_stations[duplicate_anchor], 1_005.0);
    }

    #[test]
    fn complete_route_above_two_thousand_points_is_preserved() {
        let points: Vec<[f64; 2]> = (0..2_501).map(|index| [index as f64, 0.0]).collect();
        let result = generate(request(points), Instant::now()).unwrap();
        let features = result["feature_collection"]["features"].as_array().unwrap();
        let ring = features[0]["geometry"]["coordinates"][0]
            .as_array()
            .unwrap();
        assert_eq!(ring.len(), 5_003);
        assert_eq!(ring[0], json!([0.0, -1.0]));
        assert_eq!(ring[2_500], json!([2_500.0, -1.0]));
    }

    #[test]
    fn long_curved_asymmetric_route_keeps_all_vertices() {
        let mut req = request(
            (0..2_501)
                .map(|index| {
                    let x = index as f64 * 5.0;
                    [x, (x / 300.0).sin() * 18.0]
                })
                .collect(),
        );
        req.section.left_lanes = vec![4.1, 3.2];
        req.section.right_lanes = vec![3.0];
        req.section.median_width = 1.6;
        let result = generate(req, Instant::now()).unwrap();
        let features = result["feature_collection"]["features"].as_array().unwrap();
        let ring = features[0]["geometry"]["coordinates"][0]
            .as_array()
            .unwrap();
        assert_eq!(ring.len(), 5_003);
        assert!(result["route_length_m"].as_f64().unwrap() > 12_500.0);
    }

    #[test]
    fn long_north_south_route_uses_complete_geometry() {
        let points: Vec<[f64; 2]> = (0..10_001).map(|index| [0.0, index as f64]).collect();
        assert!(first_self_intersection(&points, false).is_none());
        let result = generate(request(points), Instant::now()).unwrap();
        let ring = result["feature_collection"]["features"][0]["geometry"]["coordinates"][0]
            .as_array()
            .unwrap();
        assert_eq!(ring.len(), 20_003);
    }

    #[test]
    fn sweep_matches_naive_intersection_checks_for_open_and_closed_samples() {
        let samples: Vec<(Vec<[f64; 2]>, bool)> = vec![
            (vec![[0.0, 0.0], [0.0, 3.0], [1.0, 6.0], [0.0, 9.0]], false),
            (vec![[0.0, 0.0], [4.0, 4.0], [0.0, 4.0], [4.0, 0.0]], false),
            (
                vec![[0.0, 0.0], [5.0, 0.0], [5.0, 5.0], [0.0, 5.0], [0.0, 0.0]],
                true,
            ),
            (
                vec![[0.0, 0.0], [4.0, 4.0], [0.0, 4.0], [4.0, 0.0], [0.0, 0.0]],
                true,
            ),
        ];
        for (points, closed) in samples {
            assert_eq!(
                segments_self_intersect(&points, closed),
                naive_self_intersects(&points, closed),
                "points={points:?}, closed={closed}"
            );
        }
    }

    fn naive_self_intersects(points: &[[f64; 2]], closed: bool) -> bool {
        let segment_count = points.len().saturating_sub(1);
        for i in 0..segment_count {
            for j in (i + 2)..segment_count {
                if closed && i == 0 && j + 1 == segment_count {
                    continue;
                }
                if segments_intersect(points[i], points[i + 1], points[j], points[j + 1]) {
                    return true;
                }
            }
        }
        false
    }

    #[test]
    fn stream_keeps_processing_after_a_bad_request() {
        let valid = encoded_request(vec![[0.0, 0.0], [100.0, 0.0]]);
        let input = format!("{valid}\n{{bad json}}\n{valid}\n");
        let mut output = Vec::new();
        process_stream(Cursor::new(input), &mut output).unwrap();
        let lines: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0]["response"]["feature_count"].is_number());
        assert!(lines[1]["error"]
            .as_str()
            .unwrap()
            .contains("invalid request JSON"));
        assert!(lines[2]["response"]["feature_count"].is_number());
    }

    #[test]
    fn oversized_stream_line_is_discarded_without_corrupting_next_request() {
        let valid = encoded_request(vec![[0.0, 0.0], [100.0, 0.0]]);
        let input = format!("{}\n{valid}\n", " ".repeat(MAX_INPUT_BYTES + 1));
        let mut output = Vec::new();
        process_stream(Cursor::new(input), &mut output).unwrap();
        let lines: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0]["error"].as_str().unwrap().contains("exceeds"));
        assert!(lines[1]["response"]["feature_count"].is_number());
    }

    #[test]
    fn duplicate_non_finite_and_hairpin_inputs_are_rejected() {
        assert!(generate(request(vec![[0.0, 0.0], [0.0, 0.0]]), Instant::now()).is_err());
        assert!(generate(request(vec![[0.0, 0.0], [f64::NAN, 1.0]]), Instant::now()).is_err());
        assert!(generate(
            request(vec![[0.0, 0.0], [10.0, 0.0], [0.01, 0.0]]),
            Instant::now()
        )
        .is_err());
        assert!(generate(
            request(vec![[0.0, 0.0], [10.0, 0.0], [5.0, 0.0], [15.0, 5.0]]),
            Instant::now()
        )
        .is_err());
    }

    #[test]
    fn tight_curve_repairs_one_bounded_offset_loop_and_reports_its_extent() {
        let points = vec![
            [0.0, 0.0],
            [4.077_453_484_467_959, -3.172_788_586_179_792_4],
            [8.215_786_976_331_81, -10.938_921_486_947_251],
            [15.367_065_973_220_019, -14.165_903_044_387_537],
            [22.722_830_146_639_048, -8.302_218_164_735_702],
            [24.575_363_367_742_56, -9.235_636_653_429_756],
            [27.785_655_769_055_52, -13.269_810_194_861_883],
        ];
        let mut req = request(points.clone());
        req.section.left_lanes = vec![9.763_136_114_814_849];
        req.section.right_lanes = vec![1.0];
        req.section.median_width = 0.0;
        req.section.left_emergency_width = 0.0;
        req.section.right_emergency_width = 0.0;
        req.section.left_shoulder_width = 0.0;
        req.section.right_shoulder_width = 0.0;
        req.section.left_slope_width = 0.0;
        req.section.right_slope_width = 0.0;
        req.scene_options.enabled = vec!["markings".into(), "guardrail".into(), "lighting".into()];
        req.scene_options.offset_m = 0.0;

        let response = generate(req, Instant::now()).unwrap();
        let warnings = response["geometry_warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0]["code"], "offset_local_loop_trimmed");
        assert_eq!(warnings[0]["offset_m"], 9.763_136_114_814_849);
        assert_eq!(
            response["geometry_rule_version"],
            OFFSET_GEOMETRY_RULE_VERSION
        );
        assert!(warnings[0]["source_point_start"].is_number());
        assert!(warnings[0]["source_point_end"].is_number());
        assert!(
            warnings[0]["station_end_m"].as_f64().unwrap()
                > warnings[0]["station_start_m"].as_f64().unwrap()
        );
        assert_eq!(response["feature_count"], 2);
        assert_eq!(response["ancillary_layers"].as_array().unwrap().len(), 3);
        assert!(response["feature_collection"]["features"]
            .as_array()
            .unwrap()
            .iter()
            .all(|feature| {
                let ring: Vec<[f64; 2]> =
                    serde_json::from_value(feature["geometry"]["coordinates"][0].clone()).unwrap();
                polygon_area(&ring) > EPS
            }));

        let route: Vec<Coord> = points
            .iter()
            .map(|point| Coord {
                x: point[0],
                y: point[1],
            })
            .collect();
        let mut cumulative = vec![0.0];
        for pair in route.windows(2) {
            cumulative.push(cumulative.last().copied().unwrap() + distance(pair[0], pair[1]));
        }
        let offset = 9.763_136_114_814_849;
        let raw = offset_line_vertices(&route, offset, &cumulative).unwrap();
        let loop_extent = first_self_intersection(&raw.coordinates, false).unwrap();
        let (repaired, Some(_)) =
            offset_line_with_local_repair(&route, offset, &cumulative).unwrap()
        else {
            panic!("test curve should produce a local loop repair");
        };
        assert_eq!(repaired.coordinates.first(), raw.coordinates.first());
        assert_eq!(repaired.coordinates.last(), raw.coordinates.last());
        assert_eq!(
            &repaired.coordinates[..=loop_extent.first_segment],
            &raw.coordinates[..=loop_extent.first_segment]
        );
        assert_eq!(
            &repaired.coordinates[loop_extent.first_segment + 2..],
            &raw.coordinates[loop_extent.second_segment + 1..]
        );
    }

    #[test]
    fn large_or_true_route_loops_are_not_automatically_repaired() {
        let route: Vec<Coord> = [
            [0.0, 0.0],
            [2.368_977_094_204_712_6, 2.298_991_795_906_929_3],
            [8.478_658_240_346_84, 8.164_075_739_407_803],
            [7.747_607_872_389_031, 10.385_633_244_088_42],
            [3.563_860_864_476_86, 15.223_726_028_956_875],
            [-4.062_301_134_334_845, 16.776_778_932_292_05],
            [-12.939_141_722_192_84, 14.059_929_954_284_017],
            [-16.801_811_857_183_544, 14.763_680_666_428_494],
        ]
        .into_iter()
        .map(|point| Coord {
            x: point[0],
            y: point[1],
        })
        .collect();
        let mut cumulative = vec![0.0];
        for pair in route.windows(2) {
            cumulative.push(cumulative.last().copied().unwrap() + distance(pair[0], pair[1]));
        }
        let error = offset_line_with_local_repair(&route, 3.9, &cumulative).unwrap_err();
        assert!(error.contains("outside the local repair limit"));
        assert!(error.contains("source segments 1 and 3"));
        assert!(error.contains("estimated geometric mileages"));

        let error = generate(
            request(vec![[0.0, 0.0], [10.0, 10.0], [0.0, 10.0], [10.0, 0.0]]),
            Instant::now(),
        )
        .unwrap_err();
        assert!(error.contains("reference route self-intersects"));
    }

    #[test]
    fn one_way_sections_allow_one_empty_lane_side() {
        let mut req = request(vec![[0.0, 0.0], [100.0, 0.0]]);
        req.section.left_lanes.clear();
        req.section.right_lanes = vec![3.5, 3.5];
        req.section.median_width = 0.0;
        req.section.left_emergency_width = 0.0;
        req.section.left_shoulder_width = 0.0;
        req.section.left_slope_width = 0.0;
        let response = generate(req, Instant::now()).unwrap();
        assert_eq!(response["paved_width_m"], 9.0);
        assert_eq!(response["platform_width_m"], 9.0);
        assert_eq!(response["feature_count"], 5);
        assert_eq!(
            response["feature_collection"]["features"][0]["properties"]["side"],
            "right"
        );
    }

    #[test]
    fn crs_is_required_and_known_geographic_crs_is_rejected() {
        let mut req = request(vec![[0.0, 0.0], [10.0, 0.0]]);
        req.crs = None;
        assert!(generate(req, Instant::now())
            .unwrap_err()
            .contains("crs is required"));

        let mut req = request(vec![[0.0, 0.0], [10.0, 0.0]]);
        req.crs = Some("EPSG:4326".into());
        assert!(generate(req, Instant::now())
            .unwrap_err()
            .contains("metric geometry"));

        let mut req = request(vec![[0.0, 0.0], [10.0, 0.0]]);
        req.crs = Some("EPSG:3857".into());
        assert!(generate(req, Instant::now())
            .unwrap_err()
            .contains("metric geometry"));
    }

    #[test]
    fn empty_lane_arrays_on_both_sides_are_rejected() {
        let mut req = request(vec![[0.0, 0.0], [10.0, 0.0]]);
        req.section.left_lanes.clear();
        req.section.right_lanes.clear();
        assert!(generate(req, Instant::now())
            .unwrap_err()
            .contains("at least one side"));
    }

    #[test]
    fn total_width_above_cap_is_rejected() {
        let mut req = request(vec![[0.0, 0.0], [10.0, 0.0]]);
        req.section.left_lanes = vec![100.0];
        req.section.right_lanes = vec![100.0];
        assert!(generate(req, Instant::now())
            .unwrap_err()
            .contains("exceeds the limit"));
    }

    fn polygon_area(ring: &[[f64; 2]]) -> f64 {
        ring.windows(2)
            .map(|pair| pair[0][0] * pair[1][1] - pair[1][0] * pair[0][1])
            .sum::<f64>()
            .abs()
            / 2.0
    }
}
