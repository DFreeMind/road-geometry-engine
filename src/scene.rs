use crate::{distance, offset_line, Coord, Section};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_SCENE_OFFSET_M: f64 = 100.0;
const MAX_SCENE_SPACING_M: f64 = 10_000.0;
const EPS: f64 = 1.0e-9;

#[derive(Debug, Deserialize)]
#[serde(default)]
pub(crate) struct SceneOptions {
    pub(crate) enabled: Vec<String>,
    pub(crate) spacing_m: f64,
    pub(crate) side: String,
    pub(crate) offset_m: f64,
    pub(crate) surface_type: String,
}

impl Default for SceneOptions {
    fn default() -> Self {
        Self {
            enabled: Vec::new(),
            spacing_m: 50.0,
            side: "both".into(),
            offset_m: 1.0,
            surface_type: "asphalt".into(),
        }
    }
}

#[derive(Clone, Copy)]
struct Widths {
    left: f64,
    right: f64,
}

struct SceneContext<'a> {
    route_id: &'a str,
    source: &'a str,
    surface: &'a str,
    spacing_m: f64,
    offset_m: f64,
}

pub(crate) fn build_ancillary_layers(
    route_id: &str,
    route: &[Coord],
    section: &Section,
    options: &SceneOptions,
    source: &str,
    crs: &str,
) -> Result<Vec<Value>, String> {
    if route.len() < 2 {
        return Err("scene route must contain at least two coordinates".into());
    }
    let allowed = [
        "guardrail",
        "delineator",
        "lighting",
        "sign",
        "milestone",
        "markings",
    ];
    for name in &options.enabled {
        if !allowed.contains(&name.as_str()) {
            return Err(format!("unsupported scene facility type: {name}"));
        }
    }
    let mut enabled = options.enabled.clone();
    enabled.sort();
    enabled.dedup();
    if enabled.is_empty() {
        return Ok(Vec::new());
    }
    if !options.spacing_m.is_finite() || !(0.1..=MAX_SCENE_SPACING_M).contains(&options.spacing_m) {
        return Err(format!(
            "scene spacing_m must be between 0.1 and {MAX_SCENE_SPACING_M}m"
        ));
    }
    if !options.offset_m.is_finite() || !(0.0..=MAX_SCENE_OFFSET_M).contains(&options.offset_m) {
        return Err(format!(
            "scene offset_m must be between 0 and {MAX_SCENE_OFFSET_M}m"
        ));
    }
    if !matches!(options.side.as_str(), "both" | "left" | "right") {
        return Err("scene side must be both, left, or right".into());
    }
    if !matches!(
        options.surface_type.as_str(),
        "asphalt" | "concrete" | "gravel"
    ) {
        return Err(format!(
            "unsupported scene surface_type: {}",
            options.surface_type
        ));
    }

    let widths = section_widths(section)?;
    let sides: Vec<&str> = match options.side.as_str() {
        "both" => ["left", "right"].into_iter().collect(),
        "left" => vec!["left"],
        "right" => vec!["right"],
        _ => unreachable!(),
    };
    let sides: Vec<&str> = sides
        .into_iter()
        .filter(|side| side_width(widths, side) > 0.0)
        .collect();

    let point_kinds = ["delineator", "lighting", "sign", "milestone"];
    let context = SceneContext {
        route_id,
        source,
        surface: &options.surface_type,
        spacing_m: options.spacing_m,
        offset_m: options.offset_m,
    };
    let mut cumulative = Vec::with_capacity(route.len());
    cumulative.push(0.0);
    for pair in route.windows(2) {
        cumulative.push(cumulative.last().copied().unwrap() + distance(pair[0], pair[1]));
    }
    let route_length = *cumulative.last().unwrap();
    if !route_length.is_finite() || route_length <= EPS {
        return Err("scene route has invalid length".into());
    }
    let selected_point_kinds = enabled
        .iter()
        .filter(|kind| point_kinds.contains(&kind.as_str()))
        .count();
    let station_count = if selected_point_kinds == 0 {
        0
    } else {
        let intervals = (route_length / options.spacing_m).floor();
        if !intervals.is_finite() || intervals >= usize::MAX as f64 - 2.0 {
            return Err("scene station count exceeds the addressable resource limit".into());
        }
        let intervals = intervals as usize;
        let station_count = intervals
            .checked_add(
                1 + usize::from(intervals as f64 * options.spacing_m < route_length - 1.0e-8),
            )
            .ok_or_else(|| "scene station count overflow".to_string())?;
        if station_count as f64 >= 9_007_199_254_740_992.0 {
            return Err("scene station count exceeds floating-point station resolution".into());
        }
        let requested_points = station_count
            .checked_mul(sides.len())
            .and_then(|count| count.checked_mul(selected_point_kinds))
            .ok_or_else(|| "scene point count overflow".to_string())?;
        let _ = requested_points;
        station_count
    };

    // 预先计算所有需要的偏移线，任何一条失败都拒绝整组结果。
    let mut offsets: Vec<(f64, Vec<[f64; 2]>)> = Vec::new();
    let mut get_offset = |value: f64| -> Result<Vec<[f64; 2]>, String> {
        if let Some((_, line)) = offsets.iter().find(|(offset, _)| *offset == value) {
            return Ok(line.clone());
        }
        let line = offset_line(route, value)?;
        offsets.push((value, line.clone()));
        Ok(line)
    };

    let mut layers = Vec::new();
    for kind in [
        "markings",
        "guardrail",
        "delineator",
        "lighting",
        "sign",
        "milestone",
    ] {
        if !enabled.iter().any(|entry| entry == kind) {
            continue;
        }
        let mut features = Vec::new();
        match kind {
            "markings" => {
                let mut lines: Vec<(String, f64, &'static str)> = Vec::new();
                let median_half = section.median_width / 2.0;
                for side in ["left", "right"] {
                    let width = side_width(widths, side);
                    if width <= 0.0 {
                        continue;
                    }
                    let sign = side_sign(side);
                    if median_half > 0.0 {
                        lines.push((side.into(), sign * median_half, "median"));
                    }
                    lines.push((side.into(), sign * width, "outer"));
                    let lane_widths = if side == "left" {
                        &section.left_lanes
                    } else {
                        &section.right_lanes
                    };
                    let mut accumulated = median_half;
                    for lane_width in lane_widths {
                        accumulated += lane_width;
                        if accumulated < width - 1.0e-8 {
                            lines.push((side.into(), sign * accumulated, "lane"));
                        }
                    }
                }
                if section.median_width <= EPS && widths.left > 0.0 && widths.right > 0.0 {
                    lines.push(("center".into(), -0.075, "center"));
                    lines.push(("center".into(), 0.075, "center"));
                }
                for (side, offset, marking_class) in lines {
                    let line = get_offset(offset)?;
                    ensure_line(&line, "markings", offset)?;
                    features.push(line_feature(
                        &context,
                        kind,
                        &side,
                        &line,
                        offset,
                        marking_class,
                    ));
                }
                let left = if widths.left > 0.0 {
                    get_offset(widths.left)?
                } else {
                    route.iter().map(|point| [point.x, point.y]).collect()
                };
                let right = if widths.right > 0.0 {
                    get_offset(-widths.right)?
                } else {
                    route.iter().map(|point| [point.x, point.y]).collect()
                };
                for (station_m, left_point, right_point) in [
                    (0.0, left[0], right[0]),
                    (route_length, *left.last().unwrap(), *right.last().unwrap()),
                ] {
                    features.push(terminal_feature(
                        &context,
                        station_m,
                        left_point,
                        right_point,
                    ));
                }
            }
            "guardrail" => {
                for side in &sides {
                    let offset = side_sign(side) * (side_width(widths, side) + options.offset_m);
                    let line = get_offset(offset)?;
                    ensure_line(&line, kind, offset)?;
                    features.push(line_feature(&context, kind, side, &line, offset, ""));
                }
            }
            _ => {
                for side in &sides {
                    let reference_offset =
                        side_sign(side) * (side_width(widths, side) + options.offset_m);
                    let line = get_offset(reference_offset)?;
                    ensure_line(&line, kind, reference_offset)?;
                    let mut previous_station = -1.0;
                    for index in 0..station_count {
                        let station = (index as f64 * options.spacing_m).min(route_length);
                        if station <= previous_station {
                            return Err(
                                "scene station spacing no longer advances in floating point".into(),
                            );
                        }
                        previous_station = station;
                        let point = offset_point_at_station(route, &line, &cumulative, station)?;
                        features.push(point_feature(
                            &context,
                            kind,
                            side,
                            station,
                            reference_offset,
                            point,
                        ));
                    }
                }
            }
        }
        if features.is_empty() {
            return Err(format!("scene layer {kind} did not produce any features"));
        }
        layers.push(json!({
            "name": scene_label(kind),
            "crs": crs,
            "collection": {
                "type": "FeatureCollection",
                "features": features,
            }
        }));
    }
    Ok(layers)
}

fn section_widths(section: &Section) -> Result<Widths, String> {
    let left_lane_sum = section.left_lanes.iter().sum::<f64>();
    let right_lane_sum = section.right_lanes.iter().sum::<f64>();
    let values = [
        section.median_width,
        left_lane_sum,
        right_lane_sum,
        section.left_emergency_width,
        section.right_emergency_width,
        section.left_shoulder_width,
        section.right_shoulder_width,
    ];
    if values
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err("scene pavement widths must be finite and non-negative".into());
    }
    let widths = Widths {
        left: section.median_width / 2.0
            + left_lane_sum
            + section.left_emergency_width
            + section.left_shoulder_width,
        right: section.median_width / 2.0
            + right_lane_sum
            + section.right_emergency_width
            + section.right_shoulder_width,
    };
    if widths.left <= EPS && widths.right <= EPS {
        return Err("scene requires positive paved width on at least one side".into());
    }
    Ok(widths)
}

fn side_width(widths: Widths, side: &str) -> f64 {
    if side == "left" {
        widths.left
    } else {
        widths.right
    }
}

fn side_sign(side: &str) -> f64 {
    if side == "left" {
        1.0
    } else {
        -1.0
    }
}

fn offset_point_at_station(
    route: &[Coord],
    offset: &[[f64; 2]],
    cumulative: &[f64],
    station: f64,
) -> Result<[f64; 2], String> {
    if route.len() != offset.len() || route.len() != cumulative.len() {
        return Err("offset line does not correspond to route vertices".into());
    }
    let end_index = cumulative.partition_point(|distance| *distance < station);
    let index = end_index.saturating_sub(1).min(route.len() - 2);
    let segment_length = cumulative[index + 1] - cumulative[index];
    if !segment_length.is_finite() || segment_length <= EPS {
        return Err(format!("route contains a zero-length segment at {index}"));
    }
    let fraction = ((station - cumulative[index]) / segment_length).clamp(0.0, 1.0);
    let point = [
        offset[index][0] + (offset[index + 1][0] - offset[index][0]) * fraction,
        offset[index][1] + (offset[index + 1][1] - offset[index][1]) * fraction,
    ];
    if point.iter().all(|value| value.is_finite()) {
        Ok(point)
    } else {
        Err(format!("offset point at station {station} is not finite"))
    }
}

fn ensure_line(line: &[[f64; 2]], kind: &str, offset: f64) -> Result<(), String> {
    if line.len() < 2
        || line
            .iter()
            .flatten()
            .any(|coordinate| !coordinate.is_finite())
        || line.windows(2).all(|pair| {
            (pair[0][0] - pair[1][0]).abs() <= EPS && (pair[0][1] - pair[1][1]).abs() <= EPS
        })
    {
        return Err(format!("{kind} offset line is invalid at {offset}m"));
    }
    Ok(())
}

fn base_properties(
    context: &SceneContext<'_>,
    kind: &str,
    side: &str,
    station: f64,
    reference_offset: f64,
) -> Value {
    json!({
        "component": kind,
        "route_id": context.route_id,
        "facility_type": kind,
        "side": side,
        "station_m": station,
        "offset_m": context.offset_m,
        "reference_offset_m": reference_offset,
        "spacing_m": context.spacing_m,
        "surface_type": context.surface,
        "source": "parameter_template",
        "route_source": context.source,
        "confirmed": false,
        "symbol_is_schematic": kind != "markings",
        "rule_version": "road-scene-1",
    })
}

fn line_feature(
    context: &SceneContext<'_>,
    kind: &str,
    side: &str,
    coordinates: &[[f64; 2]],
    reference_offset: f64,
    marking_class: &str,
) -> Value {
    let mut properties = base_properties(context, kind, side, 0.0, reference_offset);
    properties["component"] = json!(kind);
    if kind == "markings" {
        properties["marking_class"] = json!(marking_class);
        properties["line_width_m"] = json!(0.15);
        properties["dash_m"] = if marking_class == "lane" {
            json!(3.0)
        } else {
            Value::Null
        };
    }
    json!({
        "type": "Feature",
        "geometry": { "type": "LineString", "coordinates": coordinates },
        "properties": properties,
    })
}

fn point_feature(
    context: &SceneContext<'_>,
    kind: &str,
    side: &str,
    station: f64,
    reference_offset: f64,
    coordinate: [f64; 2],
) -> Value {
    json!({
        "type": "Feature",
        "geometry": { "type": "Point", "coordinates": coordinate },
        "properties": base_properties(context, kind, side, station, reference_offset),
    })
}

fn terminal_feature(
    context: &SceneContext<'_>,
    station: f64,
    left: [f64; 2],
    right: [f64; 2],
) -> Value {
    let mut properties = base_properties(context, "markings", "both", station, 0.0);
    properties["marking_class"] = json!("terminal");
    properties["component"] = json!("markings");
    properties["line_width_m"] = json!(0.15);
    json!({
        "type": "Feature",
        "geometry": { "type": "LineString", "coordinates": [left, right] },
        "properties": properties,
    })
}

fn scene_label(kind: &str) -> &'static str {
    match kind {
        "markings" => "道路标线",
        "guardrail" => "护栏",
        "delineator" => "轮廓标",
        "lighting" => "路灯",
        "sign" => "标志",
        "milestone" => "里程牌",
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> Vec<Coord> {
        vec![Coord { x: 0.0, y: 0.0 }, Coord { x: 100.0, y: 0.0 }]
    }

    fn section() -> Section {
        Section {
            left_lanes: vec![3.5, 3.5],
            right_lanes: vec![3.5],
            median_width: 2.0,
            left_emergency_width: 1.0,
            right_emergency_width: 0.0,
            left_shoulder_width: 0.5,
            right_shoulder_width: 0.5,
            left_slope_width: 2.0,
            right_slope_width: 2.0,
        }
    }

    fn options(enabled: &[&str]) -> SceneOptions {
        SceneOptions {
            enabled: enabled.iter().map(|name| (*name).into()).collect(),
            ..SceneOptions::default()
        }
    }

    fn features(layers: &[Value], name: &str) -> Vec<Value> {
        layers.iter().find(|layer| layer["name"] == name).unwrap()["collection"]["features"]
            .as_array()
            .unwrap()
            .clone()
    }

    #[test]
    fn omitted_scene_options_keep_legacy_road_response_empty() {
        let layers = build_ancillary_layers(
            "R1",
            &route(),
            &section(),
            &SceneOptions::default(),
            "survey",
            "EPSG:32650",
        )
        .unwrap();
        assert!(layers.is_empty());
    }

    #[test]
    fn point_stations_include_each_interval_and_the_route_end() {
        let layers = build_ancillary_layers(
            "R1",
            &route(),
            &section(),
            &options(&["lighting"]),
            "survey",
            "EPSG:32650",
        )
        .unwrap();
        let points = features(&layers, "路灯");
        assert_eq!(points.len(), 6);
        let stations: Vec<f64> = points
            .iter()
            .map(|feature| feature["properties"]["station_m"].as_f64().unwrap())
            .collect();
        assert_eq!(stations, vec![0.0, 50.0, 100.0, 0.0, 50.0, 100.0]);
        assert!(points
            .iter()
            .all(|feature| feature["properties"]["surface_type"] == "asphalt"));
    }

    #[test]
    fn side_option_limits_points_and_uses_asymmetric_pavement_edges() {
        let mut config = options(&["sign", "guardrail"]);
        config.side = "left".into();
        config.offset_m = 2.0;
        let layers =
            build_ancillary_layers("R1", &route(), &section(), &config, "survey", "EPSG:32650")
                .unwrap();
        let signs = features(&layers, "标志");
        assert_eq!(signs.len(), 3);
        assert!(signs
            .iter()
            .all(|feature| feature["properties"]["side"] == "left"));
        assert_eq!(signs[0]["geometry"]["coordinates"][1], 11.5);
        let rail = features(&layers, "护栏");
        assert_eq!(rail.len(), 1);
        assert_eq!(rail[0]["properties"]["reference_offset_m"], 11.5);

        config.side = "right".into();
        let layers =
            build_ancillary_layers("R1", &route(), &section(), &config, "survey", "EPSG:32650")
                .unwrap();
        let rail = features(&layers, "护栏");
        assert_eq!(rail[0]["properties"]["reference_offset_m"], -7.0);
    }

    #[test]
    fn markings_include_outer_edges_lane_dividers_and_terminals() {
        let layers = build_ancillary_layers(
            "R1",
            &route(),
            &section(),
            &options(&["markings"]),
            "survey",
            "EPSG:32650",
        )
        .unwrap();
        let marks = features(&layers, "道路标线");
        let classes: Vec<&str> = marks
            .iter()
            .map(|feature| feature["properties"]["marking_class"].as_str().unwrap())
            .collect();
        assert!(classes.contains(&"outer"));
        assert!(classes.contains(&"lane"));
        assert_eq!(
            classes.iter().filter(|class| **class == "terminal").count(),
            2
        );
        let left_outer = marks
            .iter()
            .find(|feature| {
                feature["properties"]["side"] == "left"
                    && feature["properties"]["marking_class"] == "outer"
            })
            .unwrap();
        assert_eq!(left_outer["properties"]["reference_offset_m"], 9.5);
        assert_eq!(left_outer["properties"]["component"], "markings");
    }

    #[test]
    fn invalid_enable_and_spacing_are_rejected_and_large_point_sets_are_complete() {
        let mut invalid = options(&["not-a-facility"]);
        assert!(build_ancillary_layers(
            "R1",
            &route(),
            &section(),
            &invalid,
            "survey",
            "EPSG:32650"
        )
        .is_err());
        invalid = options(&["lighting"]);
        invalid.spacing_m = 0.0;
        assert!(build_ancillary_layers(
            "R1",
            &route(),
            &section(),
            &invalid,
            "survey",
            "EPSG:32650"
        )
        .is_err());
        invalid.spacing_m = 0.1;
        let long_route = vec![Coord { x: 0.0, y: 0.0 }, Coord { x: 1100.0, y: 0.0 }];
        let layers = build_ancillary_layers(
            "R1",
            &long_route,
            &section(),
            &invalid,
            "survey",
            "EPSG:32650",
        )
        .unwrap();
        assert_eq!(features(&layers, "路灯").len(), 22_002);
    }

    #[test]
    fn offset_failure_rejects_requested_scene_instead_of_dropping_features() {
        let u_turn = vec![
            Coord { x: 0.0, y: 0.0 },
            Coord { x: 10.0, y: 0.0 },
            Coord { x: 0.0, y: 0.1 },
        ];
        let config = options(&["guardrail"]);
        assert!(
            build_ancillary_layers("R1", &u_turn, &section(), &config, "survey", "EPSG:32650")
                .is_err()
        );
    }
}
