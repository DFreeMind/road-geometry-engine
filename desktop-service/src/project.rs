use serde_json::{Map, Value};
use std::fs;
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;

const MAX_PROJECT_BYTES: u64 = 128 * 1024 * 1024;

pub(crate) async fn save_project(path: String, project: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_project_blocking(path, project))
        .await
        .map_err(|error| format!("项目保存线程失败：{error}"))?
}

fn save_project_blocking(path: String, project: Value) -> Result<(), String> {
    validate_project(&project)?;
    let destination = Path::new(&path);
    if destination.exists() {
        let existing = read_project(destination)?;
        validate_project(&existing).map_err(|_| "目标文件不是可覆盖的道路项目".to_string())?;
    }
    atomic_write_json(destination, &project, u64::MAX, "项目")
}

pub(crate) async fn load_project(path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || load_project_blocking(path))
        .await
        .map_err(|error| format!("项目读取线程失败：{error}"))?
}

fn load_project_blocking(path: String) -> Result<Value, String> {
    let project = read_project(Path::new(&path))?;
    validate_project(&project)?;
    Ok(project)
}

fn read_project(path: &Path) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|error| format!("读取项目失败：{error}"))?;
    serde_json::from_reader(BufReader::new(file))
        .map_err(|error| format!("项目 JSON 无效：{error}"))
}

pub(crate) async fn read_catalog(path: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || read_catalog_blocking(path))
        .await
        .map_err(|error| format!("设施目录读取线程失败：{error}"))?
}

fn read_catalog_blocking(path: String) -> Result<Value, String> {
    let catalog = read_json_file(Path::new(&path), MAX_PROJECT_BYTES, "设施目录")?;
    validate_catalog(&catalog)?;
    Ok(catalog)
}

pub(crate) async fn save_catalog(path: String, catalog: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_catalog_blocking(path, catalog))
        .await
        .map_err(|error| format!("设施目录保存线程失败：{error}"))?
}

fn save_catalog_blocking(path: String, catalog: Value) -> Result<(), String> {
    validate_catalog(&catalog)?;
    reject_credentials(&catalog, "设施目录")?;
    let destination = Path::new(&path);
    if destination.exists() {
        let existing = read_json_file(destination, MAX_PROJECT_BYTES, "设施目录")?;
        validate_catalog(&existing).map_err(|_| "目标文件不是可覆盖的设施目录".to_string())?;
    }
    atomic_write_json(destination, &catalog, MAX_PROJECT_BYTES, "设施目录")
}

fn read_json_file(path: &Path, max_bytes: u64, label: &str) -> Result<Value, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("无法读取{label} {}：{error}", path.display()))?;
    if metadata.len() > max_bytes {
        return Err(format!("{label}超过 {max_bytes} 字节上限"));
    }
    let bytes = fs::read(path).map_err(|error| format!("读取{label}失败：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{label} JSON 无效：{error}"))
}

fn atomic_write_json(
    path: &Path,
    value: &Value,
    max_bytes: u64,
    label: &str,
) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法在目标目录创建临时{label}：{error}"))?;
    {
        // 大工程逐块编码到临时文件，不再同时保留完整 JSON 字节副本。
        let mut writer = BufWriter::new(temporary.as_file_mut());
        serde_json::to_writer_pretty(&mut writer, value)
            .map_err(|error| format!("{label} JSON 编码失败：{error}"))?;
        writer
            .flush()
            .map_err(|error| format!("写入临时{label}失败：{error}"))?;
    }
    if temporary
        .as_file()
        .metadata()
        .map_err(|error| error.to_string())?
        .len()
        > max_bytes
    {
        return Err(format!("{label}超过 {max_bytes} 字节上限"));
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("写入临时{label}失败：{error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("原子替换{label}失败：{}", error.error))?;
    Ok(())
}

fn validate_project(project: &Value) -> Result<(), String> {
    let object = project.as_object().ok_or("项目内容必须是 JSON 对象")?;
    let version = object
        .get("schema_version")
        .and_then(Value::as_u64)
        .ok_or("项目必须包含整数 schema_version")?;
    if version != 1 && version != 2 {
        return Err(format!("不支持的项目格式版本：{version}"));
    }
    if !object.get("route_points").is_some_and(valid_route_points) {
        return Err("route_points 必须为空，或包含至少 2 个有限数值坐标点".into());
    }
    required_text(object, "route_id")?;
    required_text(object, "crs")?;
    validate_project_crs(
        object
            .get("crs")
            .and_then(Value::as_str)
            .ok_or("项目字段 crs 必须是文本")?,
    )?;
    if !object.get("section").is_some_and(Value::is_object) {
        return Err("section 必须是横断面 JSON 对象".into());
    }
    if !object.get("manual_facilities").is_none_or(Value::is_array) {
        return Err("manual_facilities 必须是数组".into());
    }
    if let Some(facilities) = object.get("manual_facilities").and_then(Value::as_array) {
        if facilities.len() > 100_000 {
            return Err("manual_facilities 超过 100,000 项".into());
        }
        validate_facilities(facilities)?;
    }
    if version == 2 {
        let input_version = object
            .get("input_version")
            .and_then(Value::as_u64)
            .ok_or("schema_version 2 项目必须包含整数 input_version")?;
        if !object.get("view").is_some_and(Value::is_object) {
            return Err("schema_version 2 项目必须包含 view 对象".into());
        }
        let output = object
            .get("output")
            .ok_or("schema_version 2 项目必须包含 output")?;
        if !output.is_null()
            && (output.get("input_version").and_then(Value::as_u64) != Some(input_version)
                || !output.get("response").is_some_and(Value::is_object))
        {
            return Err("output 必须包含当前 input_version 和 response 对象".into());
        }
        validate_catalog(
            object
                .get("catalog")
                .ok_or("schema_version 2 项目必须包含 catalog")?,
        )?;
    }
    reject_credentials(project, "项目")?;
    Ok(())
}

fn validate_project_crs(crs: &str) -> Result<(), String> {
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
        return Err("项目必须使用适合区域的投影米制 CRS".into());
    }
    Ok(())
}

fn validate_facilities(facilities: &[Value]) -> Result<(), String> {
    let mut identifiers = std::collections::HashSet::new();
    for (index, facility) in facilities.iter().enumerate() {
        let id = facility
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| format!("第 {} 项设施缺少 ID", index + 1))?;
        if !identifiers.insert(id) {
            return Err(format!("设施 ID 重复：{id}"));
        }
        for key in ["x", "y"] {
            if !facility
                .get(key)
                .and_then(Value::as_f64)
                .is_some_and(f64::is_finite)
            {
                return Err(format!("设施 {id} 的 {key} 必须是有限米制坐标"));
            }
        }
        let geometry = facility
            .pointer("/template/geometry")
            .and_then(Value::as_str)
            .unwrap_or(
                if facility.get("kind").and_then(Value::as_str) == Some("guardrail") {
                    "LineString"
                } else {
                    "Point"
                },
            );
        if geometry == "LineString" {
            let endpoint = ["end_x", "end_y"].map(|key| facility.get(key).and_then(Value::as_f64));
            let [Some(x), Some(y)] = endpoint else {
                return Err(format!("线设施 {id} 缺少端点"));
            };
            let length =
                (x - facility["x"].as_f64().unwrap()).hypot(y - facility["y"].as_f64().unwrap());
            if !length.is_finite() || length <= 0.0 || length > 100_000.0 {
                return Err(format!("线设施 {id} 长度必须大于零且不超过 100 km"));
            }
        } else if geometry == "Polygon" {
            let vertices = facility
                .get("vertices")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("区域设施 {id} 缺少边界"))?;
            if !(3..=2_000).contains(&vertices.len())
                || !vertices.iter().all(|point| {
                    point.as_array().is_some_and(|pair| {
                        pair.len() == 2
                            && pair
                                .iter()
                                .all(|coordinate| coordinate.as_f64().is_some_and(f64::is_finite))
                    })
                })
            {
                return Err(format!("区域设施 {id} 需要 3 至 2,000 个有限坐标点"));
            }
        } else if geometry != "Point" {
            return Err(format!("设施 {id} 几何类型无效"));
        }
    }
    Ok(())
}

fn valid_route_points(value: &Value) -> bool {
    let Some(points) = value.as_array() else {
        return false;
    };
    points.is_empty()
        || points.len() >= 2
            && points.iter().all(|point| {
                point.as_array().is_some_and(|pair| {
                    pair.len() == 2
                        && pair
                            .iter()
                            .all(|coordinate| coordinate.as_f64().is_some_and(f64::is_finite))
                })
            })
}

fn required_text(object: &Map<String, Value>, key: &str) -> Result<(), String> {
    if object
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty() && text.len() <= 10_000)
    {
        Ok(())
    } else {
        Err(format!("项目字段 {key} 必须是非空文本"))
    }
}

fn reject_credentials(value: &Value, context: &str) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let normalized = key.to_ascii_lowercase().replace(['-', ' '], "_");
                if [
                    "password",
                    "passwd",
                    "secret",
                    "token",
                    "api_key",
                    "credential",
                    "connection_string",
                    "authorization",
                ]
                .iter()
                .any(|marker| normalized == *marker || normalized.ends_with(&format!("_{marker}")))
                    && !value.is_null()
                    && !value.as_str().is_some_and(|text| text.trim().is_empty())
                {
                    return Err(format!("{context}包含连接凭据字段 {key}，拒绝保存"));
                }
                reject_credentials(value, context)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_credentials(item, context)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn validate_catalog(catalog: &Value) -> Result<(), String> {
    let object = catalog.as_object().ok_or("catalog 必须是对象")?;
    if object.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Err("catalog.schema_version 必须为 1".into());
    }
    let entries = object
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("catalog.entries 必须是数组")?;
    if entries.len() > 5_000 {
        return Err("catalog.entries 只能包含最多 5,000 个模板对象".into());
    }
    let mut ids = std::collections::HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let item = entry
            .as_object()
            .ok_or_else(|| format!("catalog.entries[{index}] 必须是模板对象"))?;
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("catalog.entries[{index}].id 无效"))?;
        if id.is_empty()
            || id.len() > 100
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        {
            return Err(format!("catalog.entries[{index}].id 格式无效"));
        }
        if !ids.insert(id) {
            return Err(format!("设施模板 ID 重复：{id}"));
        }
        for key in ["name", "category", "subtype"] {
            if !item
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty() && value.len() <= 200)
            {
                return Err(format!("catalog.entries[{index}].{key} 必须是有效文本"));
            }
        }
        if item
            .get("revision")
            .and_then(Value::as_u64)
            .is_none_or(|revision| revision == 0)
        {
            return Err(format!("catalog.entries[{index}].revision 必须是正整数"));
        }
        if !["Point", "LineString", "Polygon"].contains(
            &item
                .get("geometry")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) {
            return Err(format!("catalog.entries[{index}].geometry 无效"));
        }
        if !item.get("specification").is_some_and(Value::is_object)
            || !item.get("placement").is_some_and(Value::is_object)
            || !item.get("source").is_some_and(Value::is_string)
            || !item.get("notes").is_some_and(Value::is_string)
        {
            return Err(format!(
                "catalog.entries[{index}] 的规格、布设或来源字段无效"
            ));
        }
    }
    Ok(())
}

pub(crate) async fn write_geojson(path: String, collection: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || write_geojson_blocking(path, collection))
        .await
        .map_err(|error| format!("GeoJSON 保存线程失败：{error}"))?
}

fn write_geojson_blocking(path: String, collection: Value) -> Result<(), String> {
    validate_geojson(&collection)?;
    let destination = Path::new(&path);
    let parent = destination
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法在目标目录创建临时 GeoJSON：{error}"))?;
    {
        let mut writer = BufWriter::new(temporary.as_file_mut());
        serde_json::to_writer_pretty(&mut writer, &collection)
            .map_err(|error| format!("GeoJSON 编码失败：{error}"))?;
        writer
            .flush()
            .map_err(|error| format!("写入临时 GeoJSON 失败：{error}"))?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("写入临时 GeoJSON 失败：{error}"))?;
    temporary
        .persist_noclobber(destination)
        .map_err(|error| format!("创建 GeoJSON 文件失败（不会覆盖已有文件）：{}", error.error))?;
    Ok(())
}

fn validate_geojson(collection: &Value) -> Result<(), String> {
    if collection.get("type").and_then(Value::as_str) != Some("FeatureCollection") {
        return Err("GeoJSON 顶层必须是 FeatureCollection".into());
    }
    if collection.get("crs").is_some() {
        return Err("RFC 7946 GeoJSON 不应包含旧式 crs 成员；坐标必须为 WGS84 经纬度".into());
    }
    let features = collection
        .get("features")
        .and_then(Value::as_array)
        .ok_or("GeoJSON features 必须是数组")?;
    for (index, feature) in features.iter().enumerate() {
        if feature.get("type").and_then(Value::as_str) != Some("Feature") {
            return Err(format!("features[{index}] 不是 Feature"));
        }
        let geometry = feature
            .get("geometry")
            .ok_or_else(|| format!("features[{index}] 缺少 geometry"))?;
        if geometry.is_null() {
            return Err(format!("features[{index}] geometry 不能为空"));
        }
        validate_geojson_geometry(geometry, index, 0)?;
    }
    Ok(())
}

fn validate_geojson_geometry(
    geometry: &Value,
    feature_index: usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 16 {
        return Err(format!(
            "features[{feature_index}] GeometryCollection 嵌套过深"
        ));
    }
    let kind = geometry
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("features[{feature_index}] geometry.type 无效"))?;
    if kind == "GeometryCollection" {
        let geometries = geometry
            .get("geometries")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("features[{feature_index}] geometries 无效"))?;
        for item in geometries {
            validate_geojson_geometry(item, feature_index, depth + 1)?;
        }
        return Ok(());
    }
    if ![
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
    ]
    .contains(&kind)
    {
        return Err(format!(
            "features[{feature_index}] 含不支持的几何类型 {kind}"
        ));
    }
    let coordinates = geometry
        .get("coordinates")
        .ok_or_else(|| format!("features[{feature_index}] 缺少 coordinates"))?;
    let mut found_position = false;
    walk_positions(coordinates, &mut found_position, feature_index)?;
    if !found_position {
        return Err(format!("features[{feature_index}] 没有坐标"));
    }
    Ok(())
}

fn walk_positions(value: &Value, found: &mut bool, feature_index: usize) -> Result<(), String> {
    let Some(items) = value.as_array() else {
        return Err(format!("features[{feature_index}] 坐标结构无效"));
    };
    if items.first().is_some_and(Value::is_number) {
        if items.len() < 2 {
            return Err(format!("features[{feature_index}] 坐标至少需要经度和纬度"));
        }
        if items
            .iter()
            .any(|value| value.as_f64().is_none_or(|number| !number.is_finite()))
        {
            return Err(format!("features[{feature_index}] 坐标必须全部为有限数值"));
        }
        let longitude = items[0]
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("features[{feature_index}] 经度无效"))?;
        let latitude = items[1]
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("features[{feature_index}] 纬度无效"))?;
        if !(-180.0..=180.0).contains(&longitude) || !(-90.0..=90.0).contains(&latitude) {
            return Err(format!(
                "features[{feature_index}] 坐标超出 WGS84 经纬度范围"
            ));
        }
        *found = true;
        return Ok(());
    }
    for item in items {
        walk_positions(item, found, feature_index)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(version: u64) -> Value {
        let mut value = serde_json::json!({
            "schema_version": version,
            "route_id": "R-1",
            "crs": "EPSG:32650",
            "route_points": [[1.0, 2.0], [3.0, 4.0]],
            "section": {"left_lanes": [3.5]},
            "manual_facilities": [],
            "scene_options": {},
            "basemap_view": {},
            "rasters": [],
            "file_basemaps": []
        });
        if version == 2 {
            value["input_version"] = Value::from(0);
            value["output"] = Value::Null;
            value["view"] = serde_json::json!({"zoom": 8.0});
            value["catalog"] = serde_json::json!({"schema_version": 1, "entries": []});
        }
        value
    }

    #[test]
    fn project_schema_one_migrates_and_schema_two_is_validated() {
        assert!(validate_project(&project(1)).is_ok());
        assert!(validate_project(&project(2)).is_ok());
        let mut invalid = project(2);
        invalid["input_version"] = Value::Null;
        assert!(validate_project(&invalid).is_err());
    }

    #[test]
    fn project_rejects_bad_coordinates_and_credentials() {
        let mut valid = project(1);
        valid["connection_id"] = Value::Null;
        valid["source_metadata"] = serde_json::json!({"connection_id": "route-link-1"});
        assert!(validate_project(&valid).is_ok());
        valid["manual_facilities"] =
            serde_json::json!([{"id":"broken", "kind":"sign", "x":null, "y":2.0}]);
        assert!(validate_project(&valid).is_err());
        let mut invalid = project(1);
        invalid["route_points"] = serde_json::json!([[1.0, 2.0], [f64::NAN, 4.0]]);
        assert!(validate_project(&invalid).is_err());
        let mut invalid = project(1);
        invalid["database"] = serde_json::json!({"access_token": "secret"});
        assert!(validate_project(&invalid).unwrap_err().contains("拒绝保存"));
        let mut invalid = project(1);
        invalid["crs"] = Value::String("EPSG:4326".into());
        assert!(validate_project(&invalid).is_err());
    }

    #[test]
    fn geojson_requires_feature_collection_and_wgs84_coordinates() {
        let valid = serde_json::json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[120.0,30.0]}}
        ]});
        assert!(validate_geojson(&valid).is_ok());
        let invalid = serde_json::json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[448000.0,4420000.0]}}
        ]});
        assert!(validate_geojson(&invalid).is_err());
    }

    #[test]
    fn project_round_trip_preserves_coordinate_float_bits() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("precise-project.json");
        let mut value = project(1);
        // 这些真实浮点尾数曾在 Qt → 服务 → 文件往返中被重新舍入。
        let x = 116.35079999999999_f64;
        let y = 4420050.123456789_f64;
        value["route_points"] = serde_json::json!([[x, y], [x + 0.001, y + 10.0]]);
        save_project_blocking(path.to_string_lossy().into_owned(), value.clone()).unwrap();
        let restored = load_project_blocking(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            restored["route_points"][0][0].as_f64().unwrap().to_bits(),
            x.to_bits()
        );
        assert_eq!(
            restored["route_points"][0][1].as_f64().unwrap().to_bits(),
            y.to_bits()
        );
        assert_eq!(restored, value);
    }

    #[test]
    fn long_route_project_round_trip_keeps_every_point() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("long-route.json");
        let mut value = project(1);
        value["route_points"] = serde_json::json!((0..10_001)
            .map(|index| [index as f64, 2.0])
            .collect::<Vec<_>>());
        save_project_blocking(path.to_string_lossy().into_owned(), value.clone()).unwrap();
        assert_eq!(
            load_project_blocking(path.to_string_lossy().into_owned()).unwrap(),
            value
        );
    }

    #[test]
    fn project_round_trip_replaces_valid_project_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("road-project.json");
        let first = project(1);
        save_project_blocking(path.to_string_lossy().into_owned(), first.clone()).unwrap();
        assert_eq!(
            load_project_blocking(path.to_string_lossy().into_owned()).unwrap(),
            first
        );

        let second = project(2);
        save_project_blocking(path.to_string_lossy().into_owned(), second.clone()).unwrap();
        assert_eq!(
            load_project_blocking(path.to_string_lossy().into_owned()).unwrap(),
            second
        );
    }

    #[test]
    fn geojson_writer_never_overwrites_an_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("existing.geojson");
        fs::write(&path, b"keep this file").unwrap();
        let collection = serde_json::json!({"type":"FeatureCollection","features":[]});
        assert!(write_geojson_blocking(path.to_string_lossy().into_owned(), collection).is_err());
        assert_eq!(fs::read(path).unwrap(), b"keep this file");
    }

    #[test]
    fn catalog_files_require_schema_one_and_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.json");
        let catalog = serde_json::json!({"schema_version": 1, "entries": [{
            "id": "custom.1", "revision": 1, "name": "标志", "category": "标志",
            "subtype": "警告标志", "geometry": "Point", "specification": {},
            "placement": {}, "source": "", "notes": ""
        }]});
        save_catalog_blocking(path.to_string_lossy().into_owned(), catalog.clone()).unwrap();
        assert_eq!(
            read_catalog_blocking(path.to_string_lossy().into_owned()).unwrap(),
            catalog
        );

        let mut invalid = catalog;
        invalid["schema_version"] = Value::from(2);
        assert!(validate_catalog(&invalid).is_err());
    }
}
