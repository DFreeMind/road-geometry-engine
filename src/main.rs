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
    for offset in boundaries {
        offsets.push((offset, offset_line(&points, offset)?));
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
                "rule_version": RULE_VERSION
            });
            if let Some(index) = component.lane_index {
                properties["lane_index"] = json!(index);
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
        "feature_count": features.len(),
        "elapsed_ms": elapsed_ms,
        "warnings": []
    });
    response["projected_crs"] = json!(crs);
    response["ancillary_layers"] = json!(scene::build_ancillary_layers(
        &request.route_id,
        &points,
        &section,
        &scene_options,
        &source,
        &crs,
    )?);
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

pub(crate) fn offset_line(points: &[Coord], offset: f64) -> Result<Vec<[f64; 2]>, String> {
    let mut output = Vec::with_capacity(points.len());
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
        let shift = match (prev, next) {
            (None, Some(n)) | (Some(n), None) => [n[0] * offset, n[1] * offset],
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
                if denom.abs() < 0.125 {
                    return Err(format!(
                        "route turn near point {i} requires an excessive miter"
                    ));
                }
                let scale = offset / denom;
                let limit = offset.abs().max(1.0) * 8.0;
                if scale.abs() > limit {
                    return Err(format!("route turn near point {i} exceeds the miter limit"));
                }
                [mx * scale, my * scale]
            }
            (None, None) => unreachable!(),
        };
        let x = points[i].x + shift[0];
        let y = points[i].y + shift[1];
        if !x.is_finite() || !y.is_finite() {
            return Err("offset geometry contains non-finite coordinates".into());
        }
        output.push([x, y]);
    }
    if polyline_self_intersects(&output) {
        return Err(format!("offset boundary at {offset}m self-intersects"));
    }
    Ok(output)
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

fn polyline_self_intersects(line: &[[f64; 2]]) -> bool {
    segments_self_intersect(line, false)
}

fn polygon_self_intersects(ring: &[[f64; 2]]) -> bool {
    segments_self_intersect(ring, true)
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
    let segment_count = points.len().saturating_sub(1);
    let Some(first) = points.first() else {
        return false;
    };
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (first[0], first[0], first[1], first[1]);
    for point in &points[1..] {
        min_x = min_x.min(point[0]);
        max_x = max_x.max(point[0]);
        min_y = min_y.min(point[1]);
        max_y = max_y.max(point[1]);
    }
    let scan_y = max_y - min_y > max_x - min_x;
    let mut segments = Vec::with_capacity(segment_count);
    for index in 0..segment_count {
        let a = points[index];
        let b = points[index + 1];
        let (scan_axis, cross_axis) = if scan_y { (1, 0) } else { (0, 1) };
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
            let adjacent = candidate.index.abs_diff(segment.index) <= 1;
            let ring_closure = closed
                && candidate.index.min(segment.index) == 0
                && candidate.index.max(segment.index) + 1 == segment_count;
            if adjacent || ring_closure {
                continue;
            }
            if candidate.max_cross + EPS < segment.min_cross
                || segment.max_cross + EPS < candidate.min_cross
            {
                continue;
            }
            if segments_intersect(candidate.a, candidate.b, segment.a, segment.b) {
                return true;
            }
        }
        active.push(segment);
    }
    false
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
        let features = result["feature_collection"]["features"].as_array().unwrap();
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
        assert!(!polyline_self_intersects(&points));
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
