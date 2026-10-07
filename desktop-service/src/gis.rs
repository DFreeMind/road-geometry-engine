use crate::runtime::RuntimeContext;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

const MAX_VECTOR_FEATURES: usize = 2_000;
const DEFAULT_REMOTE_READ_LIMIT: usize = 500;
const MAX_REMOTE_READ_LIMIT: usize = 10_000;
const MAX_FILTER_TOKENS: usize = 2_048;
const MAX_VECTOR_JSON_BYTES: usize = 128 * 1024 * 1024;
const MAX_TOOL_STDOUT_BYTES: usize = 160 * 1024 * 1024;
const MAX_TOOL_STDERR_BYTES: usize = 2 * 1024 * 1024;
const MAX_REMOTE_SCHEMAS: usize = 2_000;
const MAX_REMOTE_DATABASES: usize = 2_000;
const MAX_REMOTE_LAYERS: usize = 10_000;
const MAX_POSTGIS_COLUMNS: usize = 4_096;
const MAX_RASTERS: usize = 32;
const MAX_CACHED_TILES: usize = 128;
const MAX_ACTIVE_TILE_JOBS: usize = 2;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default)]
pub struct GisState {
    rasters: Arc<Mutex<HashMap<String, RasterSource>>>,
    tile_cache: Arc<Mutex<TileCache>>,
    active_tiles: Arc<Mutex<usize>>,
    tile_slots: Arc<Condvar>,
}

#[derive(Clone)]
struct RasterSource {
    path: PathBuf,
}

#[derive(Default)]
struct TileCache {
    tiles: HashMap<TileKey, Arc<Vec<u8>>>,
    order: VecDeque<TileKey>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct TileKey {
    id: String,
    z: u32,
    x: u32,
    y: u32,
}

struct TilePermit<'a> {
    state: &'a GisState,
}

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Drop for TilePermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.active_tiles.lock() {
            *active = active.saturating_sub(1);
            self.state.tile_slots.notify_one();
        }
    }
}

impl GisState {
    fn acquire_tile(&self) -> Result<TilePermit<'_>, String> {
        let mut active = self
            .active_tiles
            .lock()
            .map_err(|_| "栅格瓦片任务状态不可用".to_string())?;
        while *active >= MAX_ACTIVE_TILE_JOBS {
            active = self
                .tile_slots
                .wait(active)
                .map_err(|_| "栅格瓦片任务状态不可用".to_string())?;
        }
        *active += 1;
        Ok(TilePermit { state: self })
    }

    fn cache_get(&self, key: &TileKey) -> Option<Arc<Vec<u8>>> {
        let mut cache = self.tile_cache.lock().ok()?;
        let tile = cache.tiles.get(key).cloned()?;
        cache.order.retain(|entry| entry != key);
        cache.order.push_back(key.clone());
        Some(tile)
    }

    fn cache_insert(&self, key: TileKey, tile: Vec<u8>) {
        if let Ok(mut cache) = self.tile_cache.lock() {
            cache.tiles.insert(key.clone(), Arc::new(tile));
            cache.order.retain(|entry| entry != &key);
            cache.order.push_back(key);
            while cache.order.len() > MAX_CACHED_TILES {
                if let Some(expired) = cache.order.pop_front() {
                    cache.tiles.remove(&expired);
                }
            }
        }
    }
}

fn list_vector_layers_blocking(app: &RuntimeContext, path: String) -> Result<Value, String> {
    let runtime = GisRuntime::resolve(app)?;
    let source = checked_input_path(
        &path,
        &[
            "geojson", "json", "shp", "gpkg", "kml", "sqlite", "sqlite3", "db",
        ],
    )?;
    let output = run_tool_with_deadline(
        &runtime,
        "ogrinfo",
        [
            OsString::from("-ro"),
            OsString::from("-so"),
            OsString::from("-al"),
            OsString::from("-nocount"),
            OsString::from("-noextent"),
            OsString::from("-json"),
            source.as_os_str().to_owned(),
        ],
        Some(std::time::Duration::from_secs(90)),
    )?;
    let info: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "OGR 图层列表解析失败".to_string())?;
    let layers = info
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| "OGR 未返回图层列表".to_string())?;
    let summaries = layers
        .iter()
        .filter_map(|layer| {
            Some(json!({
                "name": layer.get("name")?.as_str()?,
                "geometry_type": layer.get("geometryType").cloned().unwrap_or(Value::Null),
                "feature_count": layer.get("featureCount").cloned().unwrap_or(Value::Null),
                "source_crs": find_crs(layer),
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({ "path": source, "layers": summaries }))
}

fn query_vector_data_blocking(
    app: &RuntimeContext,
    source: Value,
    query: Value,
) -> Result<Value, String> {
    let options = VectorQueryOptions::parse(&query)?;
    let source_type = source
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match source_type {
        "file" => {
            let path = source
                .get("path")
                .and_then(Value::as_str)
                .ok_or("文件数据源缺少 path")?;
            let layer = source
                .get("layer_name")
                .and_then(Value::as_str)
                .map(str::to_owned);
            query_ogr_vector(app, path, layer, options, None)
        }
        "connection" => {
            let connection = source
                .get("connection")
                .ok_or("连接数据源缺少 connection")?;
            let plan = RemoteSourcePlan::parse(connection)?;
            let runtime = GisRuntime::resolve(app)?;
            ensure_driver_available(&runtime, plan.kind)?;
            if matches!(plan.kind, "gpkg" | "sqlite") {
                let layer = Some(plan.layer_name.clone());
                query_ogr_vector(app, &plan.source, layer, options, Some(plan.kind))
            } else if plan.kind == "postgis" {
                query_postgis_vector(app, connection, options)
            } else {
                if options.has_source_filters() {
                    return Err("该连接类型尚不支持来源级筛选、offset 或 bbox；请清空这些参数后读取首批数据".into());
                }
                query_bounded_remote(app, connection, options)
            }
        }
        _ => Err("source.type 必须是 file 或 connection".into()),
    }
}

#[derive(Debug, Clone, PartialEq)]
struct VectorQueryOptions {
    filter_expression: Option<String>,
    offset: usize,
    read_limit: usize,
    bbox: Option<[f64; 4]>,
}

impl VectorQueryOptions {
    fn parse(query: &Value) -> Result<Self, String> {
        let value = json!({
            "filter_expression": query.get("expression").cloned().unwrap_or(Value::Null),
            "offset": query.get("offset").cloned().unwrap_or(Value::Null),
            "read_limit": query.get("limit").cloned().unwrap_or(Value::Null),
            "bbox": query.get("bbox").cloned().unwrap_or(Value::Null),
        });
        let mut options = RemoteReadOptions::parse(&value, DEFAULT_REMOTE_READ_LIMIT)?;
        options.read_limit = options.read_limit.min(MAX_REMOTE_READ_LIMIT);
        Ok(Self {
            filter_expression: options.filter_expression,
            offset: options.offset,
            read_limit: options.read_limit,
            bbox: options.bbox,
        })
    }

    fn has_source_filters(&self) -> bool {
        self.offset != 0 || self.filter_expression.is_some() || self.bbox.is_some()
    }
}

fn import_vector_blocking(
    app: &RuntimeContext,
    path: String,
    selected_layer: Option<String>,
) -> Result<Value, String> {
    let runtime = GisRuntime::resolve(app)?;
    let source = checked_input_path(&path, &["geojson", "json", "shp", "gpkg", "kml"])?;
    let info = run_tool(
        &runtime,
        "ogrinfo",
        ["-ro", "-so", "-al", "-json"]
            .into_iter()
            .map(OsString::from)
            .chain([source.as_os_str().to_owned()]),
    )?;
    let info: Value = serde_json::from_slice(&info.stdout)
        .map_err(|error| format!("OGR 图层元数据解析失败：{error}"))?;
    let layers = info
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| "OGR 未返回图层列表".to_string())?;
    let first_layer = if let Some(selected) = selected_layer.as_deref() {
        layers
            .iter()
            .find(|layer| layer.get("name").and_then(Value::as_str) == Some(selected))
            .ok_or_else(|| "所选图层不存在于该数据源".to_string())?
    } else {
        layers
            .first()
            .ok_or_else(|| "数据源中没有可读取图层".to_string())?
    };
    let layer_name = first_layer
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "OGR 首层缺少名称".to_string())?
        .to_string();
    let is_geojson = matches!(extension(&source).as_str(), "geojson" | "json");
    let source_crs = find_crs(first_layer)
        .or_else(|| {
            if is_geojson {
                Some("EPSG:4326".to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| "矢量数据未声明坐标系；请先补充 CRS 后导入".to_string())?;
    let feature_count = first_layer
        .get("featureCount")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    let output = run_tool(
        &runtime,
        "ogr2ogr",
        [
            OsString::from("-f"),
            OsString::from("GeoJSON"),
            OsString::from("/vsistdout/"),
            source.as_os_str().to_owned(),
            OsString::from(&layer_name),
            OsString::from("-t_srs"),
            OsString::from("EPSG:4326"),
            OsString::from("-limit"),
            OsString::from((MAX_VECTOR_FEATURES + 1).to_string()),
        ],
    )?;
    if output.stdout.len() > MAX_VECTOR_JSON_BYTES {
        return Err("矢量首层转换结果超过 128 MiB 安全上限".into());
    }
    let mut collection: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("OGR GeoJSON 输出解析失败：{error}"))?;
    if !feature_collection_coordinates_are_wgs84(&collection) {
        return Err(
            "矢量数据已请求转换为 EPSG:4326，但输出坐标超出 WGS84 经度纬度范围；拒绝标记并导入"
                .into(),
        );
    }
    let features = collection
        .get_mut("features")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "OGR 输出不是有效的 GeoJSON FeatureCollection".to_string())?;
    let observed = features.len();
    let truncated = observed > MAX_VECTOR_FEATURES
        || feature_count.is_some_and(|count| count > MAX_VECTOR_FEATURES);
    features.truncate(MAX_VECTOR_FEATURES);
    collection["collection_crs"] = json!("EPSG:4326");
    let count = feature_count.unwrap_or(observed);
    Ok(json!({
        "collection": collection,
        "source_crs": source_crs,
        "collection_crs": "EPSG:4326",
        "path": source,
        "layer_name": layer_name,
        "feature_count": count,
        "truncated": truncated,
        "fields": first_layer.get("fields").cloned().unwrap_or_else(|| json!([])),
    }))
}

fn query_ogr_vector(
    app: &RuntimeContext,
    path: &str,
    selected_layer: Option<String>,
    options: VectorQueryOptions,
    forced_kind: Option<&str>,
) -> Result<Value, String> {
    let runtime = GisRuntime::resolve(app)?;
    let source = if forced_kind.is_some() {
        PathBuf::from(path)
    } else {
        checked_input_path(
            path,
            &[
                "geojson", "json", "shp", "gpkg", "kml", "sqlite", "sqlite3", "db",
            ],
        )?
    };
    let mut metadata_args = vec![
        OsString::from("-ro"),
        OsString::from("-so"),
        OsString::from("-al"),
        OsString::from("-nocount"),
        OsString::from("-noextent"),
        OsString::from("-json"),
    ];
    if let Some(kind) = forced_kind {
        metadata_args.extend([
            OsString::from("-if"),
            OsString::from(driver_short_name(kind).unwrap_or_default()),
        ]);
    }
    metadata_args.push(source.as_os_str().to_owned());
    if let Some(layer) = selected_layer.as_deref() {
        metadata_args.push(OsString::from(layer));
    }
    let info = run_tool_with_deadline(
        &runtime,
        "ogrinfo",
        metadata_args,
        Some(std::time::Duration::from_secs(90)),
    )?;
    let metadata: Value =
        serde_json::from_slice(&info.stdout).map_err(|_| "OGR 图层元数据解析失败".to_string())?;
    let layers = metadata
        .get("layers")
        .and_then(Value::as_array)
        .ok_or("OGR 未返回图层元数据")?;
    let layer = if let Some(selected) = selected_layer.as_deref() {
        layers
            .iter()
            .find(|layer| layer.get("name").and_then(Value::as_str) == Some(selected))
            .ok_or("所选图层不存在于该数据源")?
    } else {
        layers.first().ok_or("数据源中没有可读取图层")?
    };
    let layer_name = layer
        .get("name")
        .and_then(Value::as_str)
        .ok_or("OGR 图层缺少名称")?;
    let source_crs = find_crs(layer)
        .or_else(|| {
            matches!(extension(&source).as_str(), "geojson" | "json")
                .then(|| "EPSG:4326".to_string())
        })
        .ok_or("矢量数据未声明 CRS；请先补充 CRS 后查询")?;
    let fields = layer
        .get("fields")
        .and_then(Value::as_array)
        .ok_or("OGR 图层字段元数据不可用")?;
    let allowed_fields = fields
        .iter()
        .filter_map(|field| field.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let expression = options
        .filter_expression
        .as_deref()
        .map(|expression| {
            FilterExpressionParser::new_with_dialect(
                expression,
                &allowed_fields,
                FilterDialect::Sqlite,
            )?
            .parse()
        })
        .transpose()?;
    let fid_field = layer
        .get("fidColumn")
        .or_else(|| layer.get("fid_column"))
        .or_else(|| layer.get("fidColumnName"))
        .and_then(Value::as_str);
    let fid_source = fid_field.unwrap_or("rowid");
    let stable_order = true;
    let fid_alias = Some(collision_safe_field(fields, "__road_query_fid"));
    let mut sql = format!(
        "SELECT *, {} AS {} FROM {}",
        if fid_field.is_some() {
            sql_identifier(fid_source)
        } else {
            "rowid".to_string()
        },
        sql_identifier(fid_alias.as_deref().expect("FID别名已生成")),
        sql_identifier(layer_name)
    );
    let mut predicates = Vec::new();
    if let Some(expression) = expression {
        predicates.push(expression);
    }
    if let Some([west, south, east, north]) = options.bbox {
        let geometry = layer
            .get("geometryFields")
            .and_then(Value::as_array)
            .and_then(|fields| fields.first())
            .and_then(|field| field.get("name"))
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or("geometry");
        predicates.push(sqlite_bbox_predicate(
            geometry,
            [west, south, east, north],
            &source_crs,
        )?);
    }
    if !predicates.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&predicates.join(" AND "));
    }
    if stable_order {
        sql.push_str(" ORDER BY ");
        sql.push_str(&if fid_field.is_some() {
            sql_identifier(fid_source)
        } else {
            "rowid".to_string()
        });
    }
    sql.push_str(&format!(
        " LIMIT {} OFFSET {}",
        options.read_limit + 1,
        options.offset
    ));
    let mut args = vec![
        OsString::from("-f"),
        OsString::from("GeoJSON"),
        OsString::from("/vsistdout/"),
    ];
    if let Some(kind) = forced_kind {
        args.extend([
            OsString::from("-if"),
            OsString::from(driver_short_name(kind).unwrap_or_default()),
        ]);
    }
    args.extend([
        OsString::from("-dialect"),
        OsString::from("SQLite"),
        OsString::from("-sql"),
        OsString::from(sql),
        source.as_os_str().to_owned(),
        // SQLite 查询结果可能不继承图层 CRS，显式传递已核实的源坐标系。
        OsString::from("-s_srs"),
        OsString::from(&source_crs),
        OsString::from("-t_srs"),
        OsString::from("EPSG:4326"),
        OsString::from("-preserve_fid"),
    ]);
    let output = run_tool_with_deadline(
        &runtime,
        "ogr2ogr",
        args,
        Some(std::time::Duration::from_secs(90)),
    )?;
    if output.stdout.len() > MAX_VECTOR_JSON_BYTES {
        return Err("矢量查询结果超过 128 MiB 安全上限".into());
    }
    let mut collection: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "OGR 未返回有效 GeoJSON FeatureCollection".to_string())?;
    if !feature_collection_coordinates_are_wgs84(&collection) {
        return Err(
            "矢量查询已请求转换为 EPSG:4326，但输出坐标超出 WGS84 经度纬度范围；拒绝标记".into(),
        );
    }
    let features = collection
        .get_mut("features")
        .and_then(Value::as_array_mut)
        .ok_or("OGR 输出不是有效 GeoJSON FeatureCollection")?;
    let has_more = features.len() > options.read_limit;
    features.truncate(options.read_limit);
    if let (Some(fid_alias), Some(features)) =
        (fid_alias.as_deref(), collection["features"].as_array_mut())
    {
        for feature in features {
            if let Some(properties) = feature.get_mut("properties").and_then(Value::as_object_mut) {
                if let Some(fid) = properties.remove(fid_alias) {
                    if !fid.is_null() {
                        feature["id"] = fid;
                    }
                }
            }
        }
    }
    collection["collection_crs"] = json!("EPSG:4326");
    let mut warnings = Vec::new();
    warnings.push("按 FID/rowid 排序；每页独立读取，数据变化期间的 offset 分页不是固定快照");
    if options
        .filter_expression
        .as_deref()
        .is_some_and(expression_uses_ilike)
    {
        warnings.push("SQLite 的 lower() 默认仅折叠 ASCII；ILIKE 对非 ASCII 文本的大小写匹配可能不同于 PostGIS");
    }
    let pagination_warning = (!warnings.is_empty()).then(|| warnings.join("；"));
    let spatial_filter = source_crs
        .strip_prefix("EPSG:")
        .and_then(|value| value.parse::<u32>().ok())
        .is_some();
    Ok(json!({
        "collection": collection, "source_crs": source_crs, "collection_crs": "EPSG:4326", "path": source, "layer_name": layer_name, "fields": fields,
        "offset": options.offset, "page_size": options.read_limit, "has_more": has_more,
        "filter_expression": options.filter_expression.unwrap_or_default(), "pagination_warning": pagination_warning,
            "capabilities": vector_capabilities("source", true, true, spatial_filter, Some("SQLite"), stable_order)
    }))
}

fn expression_uses_ilike(expression: &str) -> bool {
    expression.to_ascii_uppercase().contains("ILIKE")
}

fn collision_safe_field(fields: &[Value], base: &str) -> String {
    let mut candidate = base.to_string();
    while fields
        .iter()
        .any(|field| field.get("name").and_then(Value::as_str) == Some(&candidate))
    {
        candidate.push('_');
    }
    candidate
}

fn sqlite_bbox_predicate(
    geometry: &str,
    [west, south, east, north]: [f64; 4],
    source_crs: &str,
) -> Result<String, String> {
    let source_srid = source_crs
        .strip_prefix("EPSG:")
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or("当前 SQLite 空间筛选要求图层 CRS 带有 EPSG 代码；未执行 bbox 查询")?;
    Ok(format!(
        "ST_Intersects({}, ST_Transform(BuildMbr({west:.15},{south:.15},{east:.15},{north:.15},4326), {source_srid}))",
        sql_identifier(geometry)
    ))
}

fn query_postgis_vector(
    app: &RuntimeContext,
    connection: &Value,
    options: VectorQueryOptions,
) -> Result<Value, String> {
    let mut query_connection = connection.clone();
    query_connection["read_limit"] = json!(options.read_limit);
    query_connection["offset"] = json!(options.offset);
    query_connection["filter_expression"] = json!(options.filter_expression.unwrap_or_default());
    query_connection["bbox"] = options.bbox.map(|bbox| json!(bbox)).unwrap_or(Value::Null);
    let mut result = import_remote_vector_blocking(app, query_connection)?;
    let stable_order = result.get("pagination_warning").is_none_or(Value::is_null);
    if stable_order {
        result["pagination_warning"] =
            json!("按主键排序；每页独立读取，数据变化期间的 offset 分页不是固定快照");
    }
    result["capabilities"] =
        vector_capabilities("source", true, true, true, Some("PostgreSQL"), stable_order);
    Ok(result)
}

fn query_bounded_remote(
    app: &RuntimeContext,
    connection: &Value,
    options: VectorQueryOptions,
) -> Result<Value, String> {
    let mut connection_query = connection.clone();
    connection_query["read_limit"] = json!(options.read_limit);
    connection_query["offset"] = json!(0);
    connection_query["filter_expression"] = Value::Null;
    connection_query["bbox"] = Value::Null;
    let mut result = import_remote_vector_blocking(app, connection_query)?;
    result["capabilities"] = vector_capabilities("snapshot", false, false, false, None, false);
    result["offset"] = json!(0);
    result["pagination_warning"] =
        json!("此来源仅提供有界首批读取，未在数据源端筛选；不能作为稳定分页快照");
    Ok(result)
}

fn coordinate_array_is_wgs84(value: &Value) -> bool {
    let Some(items) = value.as_array() else {
        return false;
    };
    if items.is_empty() {
        return true;
    }
    if items.len() >= 2 && items[0].is_number() && items[1].is_number() {
        let Some(x) = items[0].as_f64() else {
            return false;
        };
        let Some(y) = items[1].as_f64() else {
            return false;
        };
        return x.is_finite()
            && y.is_finite()
            && (-180.0..=180.0).contains(&x)
            && (-90.0..=90.0).contains(&y)
            && items.iter().skip(2).all(Value::is_number);
    }
    items.iter().all(coordinate_array_is_wgs84)
}

fn geometry_coordinates_are_wgs84(geometry: &Value) -> bool {
    if geometry.is_null() {
        return true;
    }
    if let Some(coordinates) = geometry.get("coordinates") {
        return coordinate_array_is_wgs84(coordinates);
    }
    geometry
        .get("geometries")
        .and_then(Value::as_array)
        .is_some_and(|geometries| geometries.iter().all(geometry_coordinates_are_wgs84))
}

fn feature_collection_coordinates_are_wgs84(collection: &Value) -> bool {
    collection
        .get("features")
        .and_then(Value::as_array)
        .is_some_and(|features| {
            features.iter().all(|feature| {
                feature
                    .get("geometry")
                    .is_some_and(geometry_coordinates_are_wgs84)
            })
        })
}

fn vector_capabilities(
    query_scope: &str,
    pagination: bool,
    attribute_filter: bool,
    spatial_filter: bool,
    native_dialect: Option<&str>,
    stable_order: bool,
) -> Value {
    json!({
        "query_scope": query_scope,
        "pagination": pagination,
        "attribute_filter": attribute_filter,
        "spatial_filter": spatial_filter,
        "native_dialect": native_dialect,
        "stable_order": stable_order,
    })
}

fn database_capabilities(formats: &str) -> Value {
    let drivers = [
        ("postgis", "PostgreSQL"),
        ("mysql", "MySQL"),
        ("mssql", "MSSQLSpatial"),
        ("oracle", "OCI"),
        ("sqlite", "SQLite"),
        ("gpkg", "GPKG"),
    ];
    let capabilities = drivers
        .into_iter()
        .map(|(kind, driver)| {
            let available = has_driver(formats, driver);
            let reason = (!available).then(|| database_capability_reason(kind, driver));
            json!({"kind":kind,"available":available,"reason":reason})
        })
        .collect::<Vec<_>>();
    json!({"databases":capabilities})
}

fn driver_short_name(kind: &str) -> Option<&'static str> {
    match kind {
        "postgis" => Some("PostgreSQL"),
        "mysql" => Some("MySQL"),
        "mssql" => Some("MSSQLSpatial"),
        "oracle" => Some("OCI"),
        "sqlite" => Some("SQLite"),
        "gpkg" => Some("GPKG"),
        "wfs" => Some("WFS"),
        _ => None,
    }
}

fn has_driver(formats: &str, driver: &str) -> bool {
    formats.lines().any(|line| {
        line.split_whitespace()
            .next()
            .is_some_and(|entry| entry == driver)
    })
}

fn ensure_driver_available(runtime: &GisRuntime, kind: &str) -> Result<(), String> {
    let driver = driver_short_name(kind).ok_or("未知的空间数据源类型")?;
    let output = run_tool(runtime, "ogrinfo", [OsString::from("--formats")])?;
    let formats = String::from_utf8_lossy(&output.stdout);
    if has_driver(&formats, driver) {
        Ok(())
    } else {
        Err(database_capability_reason(kind, driver))
    }
}

fn database_capability_reason(kind: &str, driver: &str) -> String {
    match kind {
        "mssql" => "当前 GDAL 未加载 MSSQLSpatial 驱动；还需 Microsoft ODBC 客户端驱动（默认 ODBC Driver 18）".into(),
        "oracle" => "当前 GDAL 未加载 Oracle OCI 驱动；还需 Oracle Client（oci.dll）".into(),
        _ => format!("当前 GDAL 未提供 {driver} 驱动"),
    }
}

fn test_remote_connection_blocking(
    app: &RuntimeContext,
    connection: &Value,
) -> Result<Value, String> {
    let plan = RemoteSourcePlan::parse_connection(connection, false)?;
    let runtime = GisRuntime::resolve(app)?;
    ensure_driver_available(&runtime, plan.kind)?;
    let scoped_schema = matches!(plan.kind, "postgis" | "mssql" | "oracle")
        && connection.get("scope").and_then(Value::as_str) == Some("schema");
    let schema = if scoped_schema {
        Some(if plan.kind == "postgis" {
            remote_text(connection, "schema")?
        } else if plan.kind == "oracle" {
            connection
                .get("schema")
                .or_else(|| connection.get("default_schema"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Oracle 连接缺少必填项：schema 或 default_schema".to_string())?
        } else {
            connection_text(connection, "schema", database_kind_label(plan.kind))?
        })
    } else {
        None
    };
    let mut args = vec![OsString::from("-ro"), OsString::from("-json")];
    if let Some(driver) = driver_short_name(plan.kind) {
        args.extend([OsString::from("-if"), OsString::from(driver)]);
    }
    args.push(OsString::from(
        plan.probe_source.as_deref().unwrap_or(&plan.source),
    ));
    let sql_probe = match plan.kind {
        "postgis" => Some(connection_probe_sql(schema)),
        "mysql" => plan.probe_sql.clone(),
        "mssql" | "oracle" if schema.is_some() => Some(schema_probe_sql(
            plan.kind,
            schema.expect("schema checked"),
        )?),
        _ => None,
    };
    if let Some(sql) = sql_probe {
        // 只返回一行诊断属性，不读取业务表；PostGIS 缺失不等同数据库连接失败。
        args.extend([
            OsString::from("-features"),
            OsString::from("-sql"),
            OsString::from(sql),
        ]);
    } else {
        // 无 Schema 检查时只读取图层元数据，绝不输出业务要素。
        args.insert(1, OsString::from("-so"));
    }
    let output = run_tool_with_deadline(
        &runtime,
        "ogrinfo",
        args,
        Some(std::time::Duration::from_secs(30)),
    )
    .map_err(|error| connection_failure_message_for(plan.kind, &error))?;
    let info: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "服务未返回有效元数据".to_string())?;
    if plan.kind == "wfs" {
        return Ok(json!({"message":"WFS 服务连接成功（未读取要素）"}));
    }
    if plan.kind == "postgis" {
        return connection_probe_result(&info, schema.is_some());
    }
    if plan.kind == "mysql" {
        return mysql_probe_result(&info);
    }
    if matches!(plan.kind, "mssql" | "oracle") && schema.is_some() {
        return schema_probe_result(&info, plan.kind);
    }
    Ok(
        json!({"message":format!("{} 数据库连接成功（仅检查元数据，未读取要素）", database_kind_label(plan.kind))}),
    )
}

fn list_remote_databases_blocking(
    app: &RuntimeContext,
    mut connection: Value,
) -> Result<Value, String> {
    let kind = connection
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("数据库连接缺少 kind")?;
    if kind != "postgis" {
        let current = connection
            .get("database")
            .or_else(|| connection.get("service"))
            .or_else(|| connection.get("path"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned);
        return Ok(json!({
            "databases": current.into_iter().collect::<Vec<_>>(),
            "enumerable": false,
            "message": "此连接类型仅显示当前配置的目录；可手动输入其他目录名称"
        }));
    }

    // PG 系统目录允许从任意可连接数据库读取；连接配置未选库时用 postgres 做只读目录入口。
    if connection
        .get("database")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        connection["database"] = json!("postgres");
    }
    let plan = RemoteSourcePlan::parse_connection(&connection, false)?;
    let runtime = GisRuntime::resolve(app)?;
    ensure_driver_available(&runtime, plan.kind)?;
    let sql = format!(
        "SELECT datname AS database FROM pg_database WHERE datallowconn AND has_database_privilege(datname, 'CONNECT') ORDER BY datname LIMIT {}",
        MAX_REMOTE_DATABASES + 1
    );
    let databases = postgis_catalog_rows(&runtime, &plan.source, &sql, MAX_REMOTE_DATABASES)?
        .into_iter()
        .filter_map(|row| {
            row.get("database")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    Ok(json!({"databases": databases, "enumerable": true}))
}

fn list_remote_layers_blocking(app: &RuntimeContext, connection: Value) -> Result<Value, String> {
    let plan = RemoteSourcePlan::parse_connection(&connection, false)?;
    let runtime = GisRuntime::resolve(app)?;
    ensure_driver_available(&runtime, plan.kind)?;

    let scope_schema = if connection.get("scope").and_then(Value::as_str) == Some("schema") {
        connection_schema(&connection, plan.kind)?
    } else {
        None
    };
    if plan.kind == "postgis" {
        return list_postgis_catalog(&runtime, &plan.source, scope_schema);
    }

    let mut args = vec![
        OsString::from("-ro"),
        OsString::from("-so"),
        OsString::from("-json"),
        OsString::from("-al"),
        OsString::from("-nocount"),
        OsString::from("-noextent"),
    ];
    if let Some(driver) = driver_short_name(plan.kind) {
        args.extend([OsString::from("-if"), OsString::from(driver)]);
    }
    args.push(OsString::from(&plan.source));
    let output = run_tool_with_deadline(
        &runtime,
        "ogrinfo",
        args,
        Some(std::time::Duration::from_secs(60)),
    )
    .map_err(|error| connection_failure_message_for(plan.kind, &error))?;
    let info: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "远程数据源未返回有效图层目录".to_string())?;
    let raw_layers = info
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| "OGR 未返回图层目录".to_string())?;
    if raw_layers.len() > MAX_REMOTE_LAYERS {
        return Err(format!(
            "数据源图层超过 {MAX_REMOTE_LAYERS} 个，请缩小数据库范围后重试"
        ));
    }
    let summaries = remote_layer_summaries(raw_layers, plan.kind, scope_schema);
    if summaries.len() > MAX_REMOTE_LAYERS {
        return Err(format!(
            "数据源几何图层超过 {MAX_REMOTE_LAYERS} 个，请缩小数据库范围后重试"
        ));
    }
    let mut schemas = summaries
        .iter()
        .map(|layer| layer["schema"].as_str().unwrap_or_default().to_string())
        .filter(|schema| !schema.is_empty())
        .collect::<Vec<_>>();
    schemas.sort();
    schemas.dedup();
    Ok(json!({"schemas": schemas, "layers": summaries}))
}

fn list_postgis_catalog(
    runtime: &GisRuntime,
    source: &str,
    scope_schema: Option<&str>,
) -> Result<Value, String> {
    let schema_filter = scope_schema
        .map(|schema| format!(" AND n.nspname = '{}'", schema.replace('\'', "''")))
        .unwrap_or_default();
    let schemas_sql = format!(
        "SELECT n.nspname AS schema FROM pg_namespace n WHERE has_schema_privilege(n.oid, 'USAGE') AND n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'{schema_filter} ORDER BY n.nspname LIMIT {}",
        MAX_REMOTE_SCHEMAS + 1
    );
    let layer_filter = scope_schema
        .map(|schema| format!(" AND n.nspname = '{}'", schema.replace('\'', "''")))
        .unwrap_or_default();
    let layers_sql = format!(
        "SELECT n.nspname AS schema, c.relname AS table, a.attname AS geometry_column, format_type(a.atttypid, a.atttypmod) AS geometry_type FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_type t ON t.oid = a.atttypid WHERE t.typname IN ('geometry', 'geography') AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT') AND n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'{layer_filter} ORDER BY n.nspname, c.relname, a.attnum LIMIT {}",
        MAX_REMOTE_LAYERS + 1
    );
    let schemas = postgis_catalog_rows(runtime, source, &schemas_sql, MAX_REMOTE_SCHEMAS)?
        .into_iter()
        .filter_map(|row| row.get("schema").and_then(Value::as_str).map(str::to_owned))
        .collect::<Vec<_>>();
    let rows = postgis_catalog_rows(runtime, source, &layers_sql, MAX_REMOTE_LAYERS)?;
    let layers = rows
        .into_iter()
        .filter_map(|row| {
            let schema = row.get("schema")?.as_str()?;
            let table = row.get("table")?.as_str()?;
            let geometry_column = row.get("geometry_column")?.as_str()?;
            let geometry_type = row.get("geometry_type")?.as_str().unwrap_or_default();
            Some(json!({
                "schema": schema,
                "table": table,
                "geometry_column": geometry_column,
                "type_name": "",
                "geometry_type": geometry_type,
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({"schemas": schemas, "layers": layers}))
}

fn postgis_catalog_rows(
    runtime: &GisRuntime,
    source: &str,
    sql: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let output = run_tool_with_deadline(
        runtime,
        "ogrinfo",
        [
            OsString::from("-ro"),
            OsString::from("-json"),
            OsString::from("-features"),
            OsString::from("-if"),
            OsString::from("PostgreSQL"),
            OsString::from(source),
            OsString::from("-dialect"),
            OsString::from("PostgreSQL"),
            OsString::from("-sql"),
            OsString::from(sql),
        ],
        Some(std::time::Duration::from_secs(60)),
    )
    .map_err(|error| connection_failure_message_for("postgis", &error))?;
    let info: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "PostGIS 系统目录查询未返回有效 JSON".to_string())?;
    let rows = info
        .pointer("/layers/0/features")
        .and_then(Value::as_array)
        .ok_or_else(|| "PostGIS 系统目录查询未返回记录".to_string())?;
    if rows.len() > limit {
        return Err(format!(
            "目录结果超过 {limit} 条，请缩小数据库或 Schema 范围后重试"
        ));
    }
    Ok(rows
        .iter()
        .filter_map(|feature| feature.get("properties").cloned())
        .collect())
}

fn postgis_table_metadata(
    runtime: &GisRuntime,
    source: &str,
    schema: &str,
    table: &str,
) -> Result<Value, String> {
    let extension_rows = postgis_catalog_rows(
        runtime,
        source,
        "SELECT n.nspname AS extension_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='postgis' LIMIT 1",
        1,
    )?;
    let extension_schema = extension_rows
        .first()
        .and_then(|row| row.get("extension_schema"))
        .and_then(Value::as_str)
        .ok_or_else(|| "PostGIS 空间扩展目录不可用".to_string())?;
    let schema_literal = sql_literal(schema);
    let table_literal = sql_literal(table);
    let sql = format!(
        "SELECT a.attname AS column_name, (t.typname IN ('geometry', 'geography')) AS is_geometry, (t.typname='geography') AS is_geography, format_type(a.atttypid, a.atttypmod) AS column_type, col_description(a.attrelid, a.attnum) AS column_comment, CASE WHEN t.typname IN ('geometry', 'geography') THEN {}.postgis_typmod_srid(a.atttypmod) ELSE NULL END AS srid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname='{schema_literal}' AND c.relname='{table_literal}' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f') AND has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT') ORDER BY a.attnum LIMIT {}",
        sql_identifier(extension_schema),
        MAX_POSTGIS_COLUMNS + 1
    );
    let columns = postgis_catalog_rows(runtime, source, &sql, MAX_POSTGIS_COLUMNS)?;
    if columns.is_empty() {
        return Err("指定 PostGIS 表不存在或当前用户不可读取".into());
    }
    let mut geometry_fields = Vec::new();
    let mut fields = Vec::new();
    for column in columns {
        let Some(name) = column.get("column_name").and_then(Value::as_str) else {
            continue;
        };
        let is_geometry = column
            .get("is_geometry")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_geometry {
            geometry_fields.push(json!({
                "name": name,
                "type": column.get("column_type").and_then(Value::as_str).unwrap_or_default(),
                "is_geography": column.get("is_geography").and_then(Value::as_bool).unwrap_or(false),
                "srid": column.get("srid").cloned().unwrap_or(Value::Null),
            }));
        } else {
            // PostGIS 字段注释随只读元数据返回，帮助界面在映射时解释业务字段。
            fields.push(json!({
                "name": name,
                "type": column.get("column_type").and_then(Value::as_str).unwrap_or_default(),
                "description": column.get("column_comment").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    Ok(
        json!({"geometryFields": geometry_fields, "fields": fields, "extension_schema": extension_schema}),
    )
}

fn postgis_source_crs(
    runtime: &GisRuntime,
    source: &str,
    layer: &Value,
    schema: &str,
    table: &str,
    geometry_column: &str,
) -> Result<(String, i64), String> {
    let geometry = layer
        .get("geometryFields")
        .and_then(Value::as_array)
        .and_then(|fields| {
            fields
                .iter()
                .find(|field| field.get("name").and_then(Value::as_str) == Some(geometry_column))
        })
        .ok_or_else(|| "所选 PostGIS 几何列在表元数据中不存在".to_string())?;
    let extension_schema = layer
        .get("extension_schema")
        .and_then(Value::as_str)
        .ok_or_else(|| "PostGIS 空间扩展目录不可用".to_string())?;
    let typed_srid = geometry.get("srid").and_then(Value::as_i64).unwrap_or(0);
    let srid = if typed_srid > 0 {
        typed_srid
    } else {
        let sample_sql = postgis_sample_srid_sql(extension_schema, schema, table, geometry_column);
        let sample_rows = postgis_catalog_rows(runtime, source, &sample_sql, 1)?;
        sample_rows
            .first()
            .and_then(|row| row.get("srid"))
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .ok_or_else(|| "所选 PostGIS 几何列未声明 SRID，且无法从有限样本确定 CRS".to_string())?
    };
    let srs_sql = format!(
        "SELECT auth_name, auth_srid, srtext FROM {}.spatial_ref_sys WHERE srid={srid} LIMIT 1",
        sql_identifier(extension_schema)
    );
    let srs_rows = postgis_catalog_rows(runtime, source, &srs_sql, 1)?;
    let srs = srs_rows
        .first()
        .ok_or_else(|| format!("PostGIS SRID {srid} 在空间参考目录中不存在"))?;
    let identifier = postgis_crs_identifier(srs)
        .ok_or_else(|| format!("PostGIS SRID {srid} 未提供 authority 标识或 CRS 定义"))?;
    Ok((identifier, srid))
}

fn postgis_crs_identifier(spatial_ref: &Value) -> Option<String> {
    let authority = spatial_ref
        .get("auth_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let code = spatial_ref
        .get("auth_srid")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0);
    if let (Some(authority), Some(code)) = (authority, code) {
        return Some(format!("{authority}:{code}"));
    }
    spatial_ref
        .get("srtext")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn postgis_sample_srid_sql(
    extension_schema: &str,
    schema: &str,
    table: &str,
    geometry_column: &str,
) -> String {
    format!(
        "SELECT {}.ST_SRID({}) AS srid FROM {}.{} WHERE {} IS NOT NULL LIMIT 1",
        sql_identifier(extension_schema),
        sql_identifier(geometry_column),
        sql_identifier(schema),
        sql_identifier(table),
        sql_identifier(geometry_column)
    )
}

fn sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn connection_schema<'a>(connection: &'a Value, kind: &str) -> Result<Option<&'a str>, String> {
    if !matches!(kind, "postgis" | "mssql" | "oracle") {
        return Ok(None);
    }
    let schema = ["schema", "default_schema"]
        .into_iter()
        .filter_map(|key| connection.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .ok_or_else(|| format!("{} Schema 范围缺少 Schema 名称", database_kind_label(kind)))?;
    if kind != "postgis" {
        validate_simple_identifier(schema, "Schema")?;
    }
    Ok(Some(schema))
}

fn remote_layer_summaries(layers: &[Value], kind: &str, scope_schema: Option<&str>) -> Vec<Value> {
    layers
        .iter()
        .filter_map(|layer| {
            let type_name = layer.get("name")?.as_str()?.trim();
            if type_name.is_empty() {
                return None;
            }
            let (schema, table) = split_remote_layer_name(type_name, kind);
            if scope_schema.is_some_and(|expected| schema != expected) {
                return None;
            }
            let geometry_fields = layer
                .get("geometryFields")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            // 路线图层必须有几何列；仅有属性字段的普通表不能作为路线导入来源。
            if geometry_fields.is_empty() && kind != "wfs" {
                return None;
            }
            let geometry_fields = if geometry_fields.is_empty() {
                vec![Value::Null]
            } else {
                geometry_fields
            };
            Some(
                geometry_fields
                    .iter()
                    .map(|field| {
                        let geometry_column = field
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let geometry_type = field
                            .get("type")
                            .or_else(|| field.get("typeName"))
                            .or_else(|| field.get("geometryType"))
                            .and_then(Value::as_str)
                            .or_else(|| layer.get("geometryType").and_then(Value::as_str))
                            .unwrap_or_default();
                        json!({
                            "schema": schema,
                            "table": table,
                            "geometry_column": geometry_column,
                            "type_name": if kind == "wfs" { type_name } else { "" },
                            "geometry_type": geometry_type,
                        })
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .flatten()
        .collect()
}

fn split_remote_layer_name<'a>(type_name: &'a str, kind: &str) -> (&'a str, &'a str) {
    if kind == "wfs" || matches!(kind, "sqlite" | "gpkg") {
        return ("", type_name);
    }
    type_name.split_once('.').unwrap_or(("", type_name))
}

fn mysql_probe_result(info: &Value) -> Result<Value, String> {
    let properties = info
        .pointer("/layers/0/features/0/properties")
        .ok_or("MySQL 连接成功，但目标数据库不存在或当前用户不可见。")?;
    if properties.get("database_visible").and_then(Value::as_i64) != Some(1) {
        return Err("MySQL 连接成功，但目标数据库不存在或当前用户不可见。".into());
    }
    Ok(json!({"message":"MySQL/MariaDB 连接成功，目标数据库可见（未读取业务要素）"}))
}

fn schema_probe_sql(kind: &str, schema: &str) -> Result<String, String> {
    match kind {
        "mssql" => {
            let literal = schema.replace('\'', "''");
            Ok(format!("SELECT CASE WHEN EXISTS (SELECT 1 FROM sys.schemas WHERE name=N'{literal}') THEN 1 ELSE 0 END AS schema_exists, CASE WHEN HAS_PERMS_BY_NAME(N'{literal}', 'SCHEMA', 'SELECT')=1 OR EXISTS (SELECT 1 FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=N'{literal}' AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+N'.'+QUOTENAME(t.name), 'OBJECT', 'SELECT')=1) THEN 1 ELSE 0 END AS schema_access"))
        }
        "oracle" => {
            let literal = schema.replace('\'', "''");
            Ok(format!("SELECT CASE WHEN EXISTS (SELECT 1 FROM ALL_USERS WHERE USERNAME='{literal}') THEN 1 ELSE 0 END AS schema_exists, CASE WHEN EXISTS (SELECT 1 FROM ALL_TABLES WHERE OWNER='{literal}' UNION ALL SELECT 1 FROM ALL_VIEWS WHERE OWNER='{literal}') THEN 1 ELSE 0 END AS schema_access FROM dual"))
        }
        _ => Err("该数据源不支持 Schema 诊断".into()),
    }
}

fn schema_probe_result(info: &Value, kind: &str) -> Result<Value, String> {
    let properties = info
        .pointer("/layers/0/features/0/properties")
        .ok_or("数据库已响应，但 Schema 诊断查询未返回结果。请检查系统目录查询权限。")?;
    let flag = |key: &str| {
        properties
            .get(key)
            .or_else(|| properties.get(key.to_ascii_uppercase()))
            .and_then(Value::as_bool)
            .or_else(|| {
                properties
                    .get(key)
                    .or_else(|| properties.get(key.to_ascii_uppercase()))
                    .and_then(Value::as_i64)
                    .map(|value| value != 0)
            })
    };
    if flag("schema_exists") != Some(true) {
        return Err("数据库连接成功，但指定 Schema 不存在；请检查名称和大小写。".into());
    }
    if flag("schema_access") != Some(true) {
        return Ok(
            json!({"message": format!("{} 连接成功，Schema 存在；尚未确认可查询表（可能为空或权限受限），读取图层时继续检查。", database_kind_label(kind)), "schema_tables_confirmed": false}),
        );
    }
    Ok(
        json!({"message":format!("{} 连接成功，Schema 存在且可查询（未读取业务要素）", database_kind_label(kind))}),
    )
}

fn connection_probe_sql(schema: Option<&str>) -> String {
    let mut sql = "SELECT 1 AS connection_ok, EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis') AS has_postgis".to_string();
    if let Some(name) = schema {
        let name = name.replace('\'', "''");
        sql.push_str(&format!(", EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='{name}') AS schema_exists, COALESCE((SELECT has_schema_privilege(oid,'USAGE') FROM pg_namespace WHERE nspname='{name}'),FALSE) AS schema_access"));
    }
    sql
}

fn connection_probe_result(info: &Value, scoped: bool) -> Result<Value, String> {
    let properties = info
        .pointer("/layers/0/features/0/properties")
        .ok_or("数据库已响应，但诊断查询未返回结果。请检查查询权限。")?;
    if properties.get("connection_ok").and_then(Value::as_i64) != Some(1) {
        return Err("数据库诊断结果无效。".into());
    }
    if scoped && properties.get("schema_exists") != Some(&Value::Bool(true)) {
        return Err("数据库连接成功，但指定 Schema 不存在；请检查大小写和名称。".into());
    }
    if scoped && properties.get("schema_access") != Some(&Value::Bool(true)) {
        return Err("数据库连接成功，但当前用户没有指定 Schema 的 USAGE 权限。".into());
    }
    let spatial = properties.get("has_postgis") == Some(&Value::Bool(true));
    Ok(
        json!({"message": format!("PostgreSQL 连接成功{} · {}（未导入数据）", if scoped { "，Schema 可访问" } else { "" }, if spatial { "已启用 PostGIS" } else { "此库未启用 PostGIS；读取 geometry 空间表需启用扩展" }), "postgis_available":spatial}),
    )
}

#[cfg(test)]
fn connection_failure_message(error: &str) -> String {
    connection_failure_message_for("postgis", error)
}

fn connection_failure_message_for(kind: &str, error: &str) -> String {
    // 只输出错误分类，不回显原始 stderr、连接串、主机或认证凭据。
    let text = error.to_ascii_lowercase();
    let kind_hint = match kind {
        "mysql" if text.contains("access denied") || text.contains("denied for user") => {
            Some("MySQL 认证失败：请核对用户名、密码及来源主机授权。")
        }
        "mysql" if text.contains("unknown database") => {
            Some("MySQL 数据库不存在：请检查 database 名称。")
        }
        "mysql" if text.contains("can't connect") || text.contains("connect to server") => {
            Some("MySQL 服务器不可达：请检查服务、地址、端口和防火墙。")
        }
        "mssql" if text.contains("login failed") => {
            Some("SQL Server 登录失败：请核对 SQL 认证或 Windows 身份权限。")
        }
        "mssql"
            if text.contains("data source name not found") || text.contains("driver not found") =>
        {
            Some("找不到指定 ODBC 驱动：请安装配置的 SQL Server ODBC 驱动。")
        }
        "mssql"
            if text.contains("certificate") || text.contains("ssl") || text.contains("encrypt") =>
        {
            Some("SQL Server TLS 协商失败：请核对 Encrypt、TrustServerCertificate 和服务器证书。")
        }
        "oracle" if text.contains("ora-01017") => Some("Oracle 认证失败：用户名或密码无效。"),
        "oracle" if text.contains("ora-12514") || text.contains("ora-12505") => {
            Some("Oracle 服务名未在监听器注册：请检查 service。")
        }
        "oracle" if text.contains("ora-12154") => {
            Some("Oracle 无法解析连接标识：请检查 host/service 及 Oracle Net 配置。")
        }
        "oracle" if text.contains("ora-12541") => {
            Some("Oracle 监听器拒绝连接：请检查主机、端口和监听器状态。")
        }
        "oracle" if text.contains("ora-01031") => {
            Some("Oracle 权限不足：请检查连接和系统目录查询权限。")
        }
        _ => None,
    };
    if let Some(hint) = kind_hint {
        return format!("连接测试失败：{hint}");
    }
    let hint = if kind != "postgis" {
        if text.contains("timeout") || text.contains("timed out") {
            "连接超时：请检查数据库服务、网络和防火墙。"
        } else if text.contains("refused")
            || text.contains("could not connect")
            || text.contains("listener")
        {
            "数据库服务不可达：请检查地址、端口和服务监听状态。"
        } else if text.contains("permission denied") || text.contains("insufficient privilege") {
            "数据库权限不足：请检查连接及系统目录查询权限。"
        } else {
            "无法完成数据库操作：请检查服务、权限和数据源配置。"
        }
    } else if text.contains("password authentication failed")
        || text.contains("no password supplied")
    {
        "认证失败：用户名或密码未通过校验；密码不会保存，重新打开后请确认本次密码。"
    } else if text.contains("no pg_hba.conf entry") {
        "服务器拒绝此客户端：请检查 pg_hba.conf 的地址、用户及 SSL 访问规则。"
    } else if text.contains("does not exist") && text.contains("database") {
        "指定数据库不存在：请填写数据库名称，而不是 Schema 或表名。"
    } else if text.contains("does not exist") && text.contains("role") {
        "指定数据库用户不存在。"
    } else if text.contains("could not translate host name")
        || text.contains("name or service not known")
    {
        "主机名解析失败：请检查地址或 DNS。"
    } else if text.contains("ssl") || text.contains("certificate") {
        "SSL 协商或证书校验失败：请核对服务器 SSL 配置；未启用 SSL 的本地库可选择关闭 SSL。"
    } else if text.contains("timeout") || text.contains("timed out") {
        "连接超时：请检查服务器地址、端口、网络或防火墙。"
    } else if text.contains("refused")
        || text.contains("could not connect")
        || text.contains("connection to server")
    {
        "服务器不可达或拒绝连接：请检查 PostgreSQL 是否运行、监听地址和端口。"
    } else if text.contains("permission denied") {
        "数据库权限不足：请检查 CONNECT 权限和诊断查询权限。"
    } else {
        "无法完成连接测试：请核对数据库类型、服务可用性及运行资源。"
    };
    format!("连接测试失败：{hint}")
}

fn import_remote_vector_blocking(app: &RuntimeContext, connection: Value) -> Result<Value, String> {
    let plan = RemoteSourcePlan::parse(&connection)?;
    let default_read_limit = if plan.kind == "postgis" {
        DEFAULT_REMOTE_READ_LIMIT
    } else {
        MAX_VECTOR_FEATURES
    };
    let read_options = RemoteReadOptions::parse(&connection, default_read_limit)?;
    let runtime = GisRuntime::resolve(app)?;
    ensure_driver_available(&runtime, plan.kind)?;
    let RemoteSourcePlan {
        source,
        layer_name,
        label,
        mut sql,
        kind,
        page_size,
        ..
    } = plan;
    if kind != "postgis"
        && (read_options.offset != 0
            || read_options.filter_expression.is_some()
            || read_options.bbox.is_some())
    {
        return Err("当前仅 PostGIS 支持服务端筛选、空间范围和 offset 分页；该数据源不支持这些参数，请清空筛选并从首批读取".into());
    }
    // PostGIS 通过系统目录读取字段，不依赖 OGR 对含点 schema/table 的层名解释。
    let mut pagination_warning = None;
    let (layer, source_crs, srid_validation) = if kind == "postgis" {
        let schema = remote_text(&connection, "schema")?;
        let table = remote_text(&connection, "table")?;
        let geometry_column = remote_text(&connection, "geometry_column")?;
        let layer = postgis_table_metadata(&runtime, &source, schema, table)?;
        let validation_field = postgis_validation_field(&layer);
        let (source_crs, srid) =
            postgis_source_crs(&runtime, &source, &layer, schema, table, geometry_column)?;
        let primary_key = postgis_primary_key_columns(&runtime, &source, schema, table)?;
        if primary_key.is_empty() {
            pagination_warning = Some(
                "该表没有可用主键，未指定稳定分页顺序，可能重复或遗漏；即使有主键，并发修改期间的 offset 分页也不是固定快照"
                    .to_string(),
            );
        }
        sql = Some(build_postgis_page_sql(
            &layer,
            (schema, table),
            geometry_column,
            Some(&validation_field),
            &read_options,
            srid,
            Some(primary_key.as_slice()),
        )?);
        (layer, source_crs, Some((validation_field, srid)))
    } else {
        let info = run_tool_with_deadline(
            &runtime,
            "ogrinfo",
            [
                OsString::from("-ro"),
                OsString::from("-so"),
                OsString::from("-nocount"),
                OsString::from("-noextent"),
                OsString::from("-json"),
                OsString::from("-if"),
                OsString::from(driver_short_name(kind).unwrap_or_default()),
                OsString::from(&source),
                OsString::from(&layer_name),
            ],
            Some(std::time::Duration::from_secs(90)),
        )
        .map_err(|error| {
            format!(
                "无法连接远程数据源或读取图层信息：{}",
                connection_failure_message_for(kind, &error)
            )
        })?;
        let info: Value = serde_json::from_slice(&info.stdout)
            .map_err(|_| "远程数据源未返回有效图层信息".to_string())?;
        let layer = info
            .get("layers")
            .and_then(Value::as_array)
            .and_then(|layers| layers.first())
            .cloned()
            .ok_or_else(|| "远程数据源中没有可读取图层".to_string())?;
        let source_crs =
            find_crs(&layer).ok_or_else(|| "远程图层未声明 CRS；无法安全导入".to_string())?;
        (layer, source_crs, None)
    };
    let feature_count = if kind == "postgis" {
        None
    } else {
        layer
            .get("featureCount")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
    };
    let mut args = vec![
        OsString::from("-f"),
        OsString::from("GeoJSON"),
        OsString::from("/vsistdout/"),
        OsString::from("-if"),
        OsString::from(driver_short_name(kind).unwrap_or_default()),
        OsString::from(&source),
    ];
    if let Some(sql) = sql {
        if kind == "postgis" {
            args.extend([OsString::from("-dialect"), OsString::from("PostgreSQL")]);
        }
        args.extend([OsString::from("-sql"), OsString::from(sql)]);
    } else {
        args.push(OsString::from(layer_name.clone()));
    }
    args.extend([
        OsString::from("-t_srs"),
        OsString::from("EPSG:4326"),
        OsString::from("-limit"),
        OsString::from((read_options.read_limit + 1).to_string()),
    ]);
    if kind == "wfs" {
        args.extend([
            OsString::from("--config"),
            OsString::from("OGR_WFS_PAGE_SIZE"),
            OsString::from(page_size.to_string()),
        ]);
    }
    let output = run_tool_with_deadline(
        &runtime,
        "ogr2ogr",
        args,
        Some(std::time::Duration::from_secs(90)),
    )
    .map_err(|error| {
        format!(
            "远程要素读取失败：{}",
            connection_failure_message_for(kind, &error)
        )
    })?;
    if output.stdout.len() > MAX_VECTOR_JSON_BYTES {
        return Err("远程矢量转换结果超过 128 MiB 安全上限".into());
    }
    let mut collection: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "远程图层未返回有效 GeoJSON".to_string())?;
    if !feature_collection_coordinates_are_wgs84(&collection) {
        return Err(
            "远程图层已请求转换为 EPSG:4326，但输出坐标超出 WGS84 经度纬度范围；拒绝标记并导入"
                .into(),
        );
    }
    let features = collection
        .get_mut("features")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "远程图层未返回 GeoJSON 要素".to_string())?;
    let observed = features.len();
    if let Some((field, expected_srid)) = srid_validation {
        validate_postgis_batch_srid(features, &field, expected_srid)?;
    }
    let has_more = if kind == "postgis" {
        observed > read_options.read_limit
    } else {
        observed > read_options.read_limit || feature_count.is_some_and(|count| count > observed)
    };
    features.truncate(read_options.read_limit);
    let count = features.len();
    collection["collection_crs"] = json!("EPSG:4326");
    Ok(json!({
        "collection": collection,
        "source_crs": source_crs,
        "collection_crs": "EPSG:4326",
        "path": label,
        "layer_name": layer_name,
        "feature_count": count,
        "truncated": has_more,
        "has_more": has_more,
        "page_size": read_options.read_limit,
        "offset": read_options.offset,
        "filter_expression": read_options.filter_expression.unwrap_or_default(),
        "pagination_warning": pagination_warning,
        "fields": layer.get("fields").cloned().unwrap_or_else(|| json!([])),
    }))
}

struct RemoteSourcePlan {
    source: String,
    probe_source: Option<String>,
    probe_sql: Option<String>,
    layer_name: String,
    label: String,
    sql: Option<String>,
    kind: &'static str,
    page_size: usize,
}

impl RemoteSourcePlan {
    fn parse(connection: &Value) -> Result<Self, String> {
        Self::parse_connection(connection, true)
    }

    fn parse_connection(connection: &Value, require_layer: bool) -> Result<Self, String> {
        let kind = connection
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let limit = connection
            .get("page_size")
            .and_then(Value::as_u64)
            .unwrap_or(500)
            .clamp(50, 500) as usize;
        let (source, probe_source, probe_sql, layer_name, label, sql) = match kind {
            "wfs" => {
                let url = remote_text(connection, "url")?;
                let type_name = if require_layer {
                    remote_text(connection, "type_name")?
                } else {
                    ""
                };
                if !valid_http_url(url) {
                    return Err("请输入 HTTP(S) WFS 服务地址".into());
                }
                let version = connection
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("auto");
                if !matches!(version, "auto" | "2.0.0" | "1.1.0" | "1.0.0") {
                    return Err("WFS 版本无效".into());
                }
                let mut endpoint = url.to_string();
                if !endpoint.contains('?') {
                    endpoint.push_str("?service=WFS");
                } else if !endpoint.to_ascii_lowercase().contains("service=wfs") {
                    endpoint.push_str("&service=WFS");
                }
                if version != "auto" && !endpoint.to_ascii_lowercase().contains("version=") {
                    endpoint.push_str(&format!("&version={version}"));
                }
                (
                    format!("WFS:{endpoint}"),
                    None,
                    None,
                    type_name.to_string(),
                    type_name.to_string(),
                    None,
                )
            }
            "postgis" => {
                let host = remote_text(connection, "host")?;
                let database = remote_text(connection, "database")?;
                let schema = if require_layer {
                    remote_text(connection, "schema")?
                } else {
                    ""
                };
                let table = if require_layer {
                    remote_text(connection, "table")?
                } else {
                    ""
                };
                let _geometry_column = if require_layer {
                    remote_text(connection, "geometry_column")?
                } else {
                    ""
                };
                let user = remote_text(connection, "user")?;
                let password = connection
                    .get("password")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let port = connection
                    .get("port")
                    .and_then(Value::as_u64)
                    .unwrap_or(5432);
                if port == 0 || port > 65535 {
                    return Err("PostGIS 端口必须在 1 到 65535 之间".into());
                }
                let sslmode = match connection
                    .get("sslmode")
                    .and_then(Value::as_str)
                    .unwrap_or("prefer")
                {
                    "disable" => "disable",
                    "prefer" => "prefer",
                    "require" => "require",
                    _ => return Err("PostGIS SSL 模式无效".into()),
                };
                // GDAL/OGR 消费临时连接串；所有远程错误均由下方统一脱敏。
                let source = format!(
                "PG:host={} port={} dbname={} user={} password={} sslmode={} connect_timeout=20",
                pg_quote(host),
                port,
                pg_quote(database),
                pg_quote(user),
                pg_quote(password),
                sslmode
            );
                (
                    source,
                    None,
                    None,
                    format!("{schema}.{table}"),
                    format!("{schema}.{table}"),
                    None,
                )
            }
            "mysql" => {
                let host = connection_text(connection, "host", "MySQL")?;
                let database = connection_text(connection, "database", "MySQL")?;
                let user = connection_text(connection, "user", "MySQL")?;
                let password = connection
                    .get("password")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let port = remote_port(connection, 3306, "MySQL")?;
                for (field, value) in [
                    ("host", host),
                    ("database", database),
                    ("user", user),
                    ("password", password),
                ] {
                    reject_connection_delimiters(value, &['\0', '\n', '\r'], "MySQL", field)?;
                }
                let layer = if require_layer {
                    connection_text(connection, "table", "MySQL")?
                } else {
                    ""
                };
                if require_layer {
                    validate_simple_identifier(layer, "表名")?;
                }
                let source = format!(
                    "MYSQL:{},host={},port={port},user={},password={}{}",
                    mysql_quote(database),
                    mysql_quote(host),
                    mysql_quote(user),
                    mysql_quote(password),
                    if layer.is_empty() {
                        String::new()
                    } else {
                        format!(",tables={layer}")
                    }
                );
                let probe_source = format!(
                    "MYSQL:{},host={},port={port},user={},password={},tables=SCHEMATA",
                    mysql_quote("information_schema"),
                    mysql_quote(host),
                    mysql_quote(user),
                    mysql_quote(password)
                );
                let probe_sql = format!("SELECT EXISTS(SELECT 1 FROM SCHEMATA WHERE SCHEMA_NAME='{}') AS database_visible", database.replace('\'', "''"));
                (
                    source,
                    Some(probe_source),
                    Some(probe_sql),
                    layer.to_string(),
                    if layer.is_empty() {
                        database.to_string()
                    } else {
                        format!("{database}.{layer}")
                    },
                    None,
                )
            }
            "mssql" => {
                let host = connection_text(connection, "host", "SQL Server")?;
                let database = connection_text(connection, "database", "SQL Server")?;
                let port = remote_port(connection, 1433, "SQL Server")?;
                for (field, value) in [("host", host), ("database", database)] {
                    reject_connection_delimiters(
                        value,
                        &[';', '{', '}', '\0', '\n', '\r'],
                        "SQL Server",
                        field,
                    )?;
                }
                reject_connection_delimiters(host, &[','], "SQL Server", "host")?;
                let auth = connection
                    .get("auth")
                    .and_then(Value::as_str)
                    .unwrap_or("sql");
                let driver = connection
                    .get("odbc_driver")
                    .and_then(Value::as_str)
                    .unwrap_or("ODBC Driver 18 for SQL Server")
                    .trim();
                if driver.is_empty() || driver.len() > 128 {
                    return Err("SQL Server ODBC 驱动名称无效".into());
                }
                let encrypt = yes_no(connection, "encrypt", "yes", "SQL Server")?;
                let trust = yes_no(connection, "trust_certificate", "no", "SQL Server")?;
                reject_connection_delimiters(
                    driver,
                    &['\0', '\n', '\r'],
                    "SQL Server",
                    "odbc_driver",
                )?;
                let mut source = format!(
                    "MSSQL:DRIVER={};SERVER={};DATABASE={};Encrypt={encrypt};TrustServerCertificate={trust}",
                    odbc_value(driver),
                    odbc_value(&format!("{host},{port}")),
                    odbc_value(database),
                );
                match auth {
                    "windows" => source.push_str(";Trusted_Connection=yes"),
                    "sql" => {
                        let user = connection_text(connection, "user", "SQL Server")?;
                        let password = connection
                            .get("password")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        reject_connection_delimiters(
                            user,
                            &['\0', '\n', '\r'],
                            "SQL Server",
                            "user",
                        )?;
                        reject_connection_delimiters(
                            password,
                            &['\0', '\n', '\r'],
                            "SQL Server",
                            "password",
                        )?;
                        source.push_str(&format!(
                            ";UID={};PWD={}",
                            odbc_value(user),
                            odbc_value(password)
                        ));
                    }
                    _ => return Err("SQL Server auth 必须是 sql 或 windows".into()),
                }
                let schema = connection
                    .get("schema")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let table = if require_layer {
                    connection_text(connection, "table", "SQL Server")?
                } else {
                    ""
                };
                if !schema.is_empty() {
                    validate_simple_identifier(schema, "Schema")?;
                }
                if require_layer {
                    validate_simple_identifier(table, "表名")?;
                }
                let geometry_column = if require_layer {
                    let column = connection_text(connection, "geometry_column", "SQL Server")?;
                    validate_simple_identifier(column, "几何列名")?;
                    column
                } else {
                    ""
                };
                let layer = if schema.is_empty() {
                    table.to_string()
                } else {
                    format!("{schema}.{table}")
                };
                let source = if require_layer {
                    format!("{source};Tables={}({geometry_column})", layer)
                } else {
                    source
                };
                (
                    source,
                    None,
                    None,
                    layer.clone(),
                    if layer.is_empty() {
                        database.to_string()
                    } else {
                        layer
                    },
                    None,
                )
            }
            "oracle" => {
                let host = connection_text(connection, "host", "Oracle")?;
                let service = connection_text(connection, "service", "Oracle")?;
                let user = connection_text(connection, "user", "Oracle")?;
                let password = connection
                    .get("password")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let port = remote_port(connection, 1521, "Oracle")?;
                for (field, value) in [
                    ("host", host),
                    ("service", service),
                    ("user", user),
                    ("password", password),
                ] {
                    reject_connection_delimiters(
                        value,
                        &['/', '@', ':', '\0', '\n', '\r'],
                        "Oracle",
                        field,
                    )?;
                }
                validate_simple_identifier(user, "Oracle 用户名")?;
                // OCI datasource names have no documented escape syntax for these delimiters.
                if password
                    .chars()
                    .any(|character| matches!(character, '/' | '@' | ':' | '\\'))
                {
                    return Err("Oracle 密码含 OCI 连接串不支持的 /、@、: 或反斜杠字符".into());
                }
                let schema = connection
                    .get("schema")
                    .or_else(|| connection.get("default_schema"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let table = if require_layer {
                    connection_text(connection, "table", "Oracle")?
                } else {
                    ""
                };
                if !schema.is_empty() {
                    validate_simple_identifier(schema, "Schema")?;
                }
                if require_layer {
                    validate_simple_identifier(table, "表名")?;
                }
                let layer = if table.is_empty() {
                    String::new()
                } else if schema.is_empty() {
                    table.to_string()
                } else {
                    format!("{schema}.{table}")
                };
                let source = format!(
                    "OCI:{user}/{password}@{host}:{port}/{service}{}",
                    if layer.is_empty() {
                        String::new()
                    } else {
                        format!(":{layer}")
                    }
                );
                (
                    source,
                    None,
                    None,
                    layer.clone(),
                    if layer.is_empty() {
                        service.to_string()
                    } else {
                        layer
                    },
                    None,
                )
            }
            "sqlite" | "gpkg" => {
                let path = connection_text(connection, "path", "本地空间数据库")?;
                let allowed = if kind == "gpkg" {
                    &["gpkg"][..]
                } else {
                    &["sqlite", "sqlite3", "db"][..]
                };
                let path = checked_input_path(path, allowed)?;
                let layer = if require_layer {
                    connection
                        .get("layer")
                        .or_else(|| connection.get("table"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| "本地空间数据库连接缺少必填项：layer".to_string())?
                } else {
                    ""
                };
                if require_layer {
                    validate_simple_identifier(layer, "图层名")?;
                }
                (
                    path.to_string_lossy().into_owned(),
                    None,
                    None,
                    layer.to_string(),
                    if layer.is_empty() {
                        path.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned()
                    } else {
                        layer.to_string()
                    },
                    None,
                )
            }
            _ => return Err(
                "数据源类型必须是 WFS、PostGIS、MySQL、SQL Server、Oracle、SQLite 或 GeoPackage"
                    .into(),
            ),
        };
        let kind = match kind {
            "wfs" => "wfs",
            "postgis" => "postgis",
            "mysql" => "mysql",
            "mssql" => "mssql",
            "oracle" => "oracle",
            "sqlite" => "sqlite",
            "gpkg" => "gpkg",
            _ => unreachable!(),
        };
        Ok(Self {
            source,
            probe_source,
            probe_sql,
            layer_name,
            label,
            sql,
            kind,
            page_size: limit,
        })
    }
}

fn valid_http_url(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    matches!(scheme, "http" | "https")
        && rest
            .split('/')
            .next()
            .is_some_and(|authority| !authority.is_empty())
        && !value.chars().any(char::is_whitespace)
}

fn remote_text<'a>(connection: &'a Value, key: &str) -> Result<&'a str, String> {
    connection
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("远程连接缺少必填项：{key}"))
}

fn connection_text<'a>(connection: &'a Value, key: &str, engine: &str) -> Result<&'a str, String> {
    connection
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{engine} 连接缺少必填项：{key}"))
}

fn remote_port(connection: &Value, default: u64, engine: &str) -> Result<u64, String> {
    let port = connection
        .get("port")
        .and_then(Value::as_u64)
        .unwrap_or(default);
    if !(1..=65535).contains(&port) {
        return Err(format!("{engine} 端口必须在 1 到 65535 之间"));
    }
    Ok(port)
}

fn reject_connection_delimiters(
    value: &str,
    delimiters: &[char],
    engine: &str,
    field: &str,
) -> Result<(), String> {
    if value
        .chars()
        .any(|character| delimiters.contains(&character))
    {
        return Err(format!("{engine} {field} 包含连接参数分隔符或控制字符"));
    }
    Ok(())
}

fn mysql_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn odbc_value(value: &str) -> String {
    format!("{{{}}}", value.replace('}', "}}"))
}

fn yes_no(
    connection: &Value,
    key: &str,
    default: &str,
    engine: &str,
) -> Result<&'static str, String> {
    match connection
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
    {
        "yes" => Ok("yes"),
        "no" => Ok("no"),
        _ => Err(format!("{engine} {key} 必须是 yes 或 no")),
    }
}

fn validate_simple_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '_' | '$'))
    {
        return Err(format!(
            "{label}仅允许字母、数字、下划线或美元符号，且长度不得超过 128 字节"
        ));
    }
    Ok(())
}

fn database_kind_label(kind: &str) -> &'static str {
    match kind {
        "mysql" => "MySQL/MariaDB",
        "mssql" => "SQL Server",
        "oracle" => "Oracle Spatial",
        "sqlite" => "SQLite/SpatiaLite",
        "gpkg" => "GeoPackage",
        _ => "数据库",
    }
}

fn pg_quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn sql_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[derive(Debug, Clone, PartialEq)]
struct RemoteReadOptions {
    filter_expression: Option<String>,
    offset: usize,
    read_limit: usize,
    bbox: Option<[f64; 4]>,
}

impl RemoteReadOptions {
    fn parse(connection: &Value, default_read_limit: usize) -> Result<Self, String> {
        let filter_expression = match connection.get("filter_expression") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if value.trim().is_empty() => None,
            Some(Value::String(value)) if value.len() <= 16_384 => Some(value.clone()),
            Some(Value::String(_)) => return Err("筛选表达式超过 16 KiB 安全上限".into()),
            Some(_) => return Err("筛选表达式必须是字符串".into()),
        };
        let offset = match connection.get("offset") {
            None | Some(Value::Null) => 0,
            Some(value) => value
                .as_u64()
                .and_then(|number| usize::try_from(number).ok())
                .filter(|number| *number <= i64::MAX as usize)
                .ok_or_else(|| {
                    "分页 offset 必须是 0 到 9223372036854775807 之间的整数".to_string()
                })?,
        };
        let read_limit = match connection.get("read_limit") {
            None | Some(Value::Null) => default_read_limit,
            Some(value) => value
                .as_u64()
                .and_then(|number| usize::try_from(number).ok())
                .filter(|number| (1..=MAX_REMOTE_READ_LIMIT).contains(number))
                .ok_or_else(|| format!("单批读取量必须在 1 到 {MAX_REMOTE_READ_LIMIT} 之间"))?,
        };
        let bbox = match connection.get("bbox") {
            None | Some(Value::Null) => None,
            Some(Value::Array(values)) if values.len() == 4 => {
                let mut coordinates = [0.0; 4];
                for (index, value) in values.iter().enumerate() {
                    coordinates[index] = value
                        .as_f64()
                        .filter(|number| number.is_finite())
                        .ok_or_else(|| {
                            "WGS84 空间范围必须包含四个有限数字 [west,south,east,north]".to_string()
                        })?;
                }
                let [west, south, east, north] = coordinates;
                if !(-180.0..=180.0).contains(&west)
                    || !(-180.0..=180.0).contains(&east)
                    || !(-90.0..=90.0).contains(&south)
                    || !(-90.0..=90.0).contains(&north)
                    || west >= east
                    || south >= north
                {
                    return Err("WGS84 空间范围无效：经度需递增且位于 -180 到 180，纬度需递增且位于 -90 到 90".into());
                }
                Some(coordinates)
            }
            Some(_) => return Err("WGS84 空间范围必须为 [west,south,east,north] 四个数字".into()),
        };
        Ok(Self {
            filter_expression,
            offset,
            read_limit,
            bbox,
        })
    }
}

fn postgis_primary_key_columns(
    runtime: &GisRuntime,
    source: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let sql = format!(
        "SELECT a.attname AS column_name FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, position) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.attnum WHERE i.indisprimary AND n.nspname='{}' AND c.relname='{}' ORDER BY key.position LIMIT 33",
        sql_literal(schema),
        sql_literal(table)
    );
    let rows = postgis_catalog_rows(runtime, source, &sql, 32)?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            row.get("column_name")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect())
}

fn build_postgis_page_sql(
    layer: &Value,
    schema_table: (&str, &str),
    selected_geometry: &str,
    validation_field: Option<&str>,
    options: &RemoteReadOptions,
    srid: i64,
    primary_key: Option<&[String]>,
) -> Result<String, String> {
    let (schema, table) = schema_table;
    if srid <= 0 {
        return Err("所选 PostGIS 几何列的 SRID 无效，无法生成空间筛选".into());
    }
    let mut sql =
        build_postgis_import_sql(layer, schema, table, selected_geometry, validation_field)?;
    let geometry = layer["geometryFields"]
        .as_array()
        .and_then(|fields| {
            fields
                .iter()
                .find(|field| field["name"].as_str() == Some(selected_geometry))
        })
        .ok_or_else(|| "所选 PostGIS 几何列在表元数据中不存在".to_string())?;
    let mut predicates = Vec::new();
    if let Some(expression) = options.filter_expression.as_deref() {
        let mut allowed_fields = Vec::new();
        for key in ["fields", "geometryFields"] {
            if let Some(fields) = layer.get(key).and_then(Value::as_array) {
                allowed_fields.extend(
                    fields
                        .iter()
                        .filter_map(|field| field.get("name").and_then(Value::as_str)),
                );
            }
        }
        predicates.push(FilterExpressionParser::new(expression, &allowed_fields)?.parse()?);
    }
    if let Some([west, south, east, north]) = options.bbox {
        let envelope = format!(
            "{}.ST_Transform({}.ST_MakeEnvelope({west:.15},{south:.15},{east:.15},{north:.15},4326),{srid})",
            sql_identifier(layer["extension_schema"].as_str().ok_or_else(|| "PostGIS 空间扩展目录不可用".to_string())?),
            sql_identifier(layer["extension_schema"].as_str().ok_or_else(|| "PostGIS 空间扩展目录不可用".to_string())?)
        );
        let column = sql_identifier(selected_geometry);
        let is_geography = geometry
            .get("is_geography")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        predicates.push(if is_geography {
            format!(
                "{column} && ({envelope})::{}.geography",
                sql_identifier(
                    layer["extension_schema"]
                        .as_str()
                        .expect("extension schema checked above")
                )
            )
        } else {
            format!("{column} && {envelope}")
        });
    }
    if !predicates.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&predicates.join(" AND "));
    }
    if let Some(primary_key) = primary_key.filter(|columns| !columns.is_empty()) {
        sql.push_str(" ORDER BY ");
        sql.push_str(
            &primary_key
                .iter()
                .map(|name| sql_identifier(name))
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    sql.push_str(&format!(
        " LIMIT {} OFFSET {}",
        options.read_limit + 1,
        options.offset
    ));
    Ok(sql)
}

#[derive(Debug, Clone, PartialEq)]
enum FilterToken {
    Identifier(String, bool),
    String(String),
    Number(String),
    Word(String),
    Operator(&'static str),
    LParen,
    RParen,
    Comma,
    End,
}

struct FilterExpressionParser<'a> {
    input: &'a str,
    fields: std::collections::HashSet<&'a str>,
    tokens: Vec<FilterToken>,
    position: usize,
    depth: usize,
    dialect: FilterDialect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilterDialect {
    Postgres,
    Sqlite,
}

impl<'a> FilterExpressionParser<'a> {
    fn new(input: &'a str, fields: &[&'a str]) -> Result<Self, String> {
        Self::new_with_dialect(input, fields, FilterDialect::Postgres)
    }

    fn new_with_dialect(
        input: &'a str,
        fields: &[&'a str],
        dialect: FilterDialect,
    ) -> Result<Self, String> {
        let tokens = tokenize_filter_expression(input)?;
        Ok(Self {
            input,
            fields: fields.iter().copied().collect(),
            tokens,
            position: 0,
            depth: 0,
            dialect,
        })
    }

    fn parse(mut self) -> Result<String, String> {
        let sql = self.parse_or()?;
        if self.peek() != &FilterToken::End {
            return Err(self.invalid());
        }
        Ok(sql)
    }

    fn parse_or(&mut self) -> Result<String, String> {
        let mut left = self.parse_and()?;
        while self.take_word("OR") {
            let right = self.parse_and()?;
            left = format!("({left} OR {right})");
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<String, String> {
        let mut left = self.parse_not()?;
        while self.take_word("AND") {
            let right = self.parse_not()?;
            left = format!("({left} AND {right})");
        }
        Ok(left)
    }

    fn parse_not(&mut self) -> Result<String, String> {
        if self.take_word("NOT") {
            return self.with_depth(|parser| Ok(format!("(NOT {})", parser.parse_not()?)));
        }
        self.parse_predicate()
    }

    fn parse_predicate(&mut self) -> Result<String, String> {
        let mut left = self.parse_primary()?;
        if let FilterToken::Operator(operator) = self.peek() {
            let operator = *operator;
            self.position += 1;
            let right = self.parse_primary()?;
            return Ok(format!("({left} {operator} {right})"));
        }
        if self.take_word("IS") {
            let not = self.take_word("NOT");
            if !self.take_word("NULL") {
                return Err(self.invalid());
            }
            return Ok(format!("({left} IS {}NULL)", if not { "NOT " } else { "" }));
        }
        let negate = self.take_word("NOT");
        if self.take_word("LIKE") || self.take_word("ILIKE") {
            let operator = match &self.tokens[self.position - 1] {
                FilterToken::Word(word) => word.to_ascii_uppercase(),
                _ => unreachable!(),
            };
            let mut right = self.parse_primary()?;
            let sqlite_ilike = operator == "ILIKE" && self.dialect == FilterDialect::Sqlite;
            if sqlite_ilike {
                left = format!("lower({left})");
                right = format!("lower({right})");
            }
            return Ok(format!(
                "({left} {} {} {right})",
                if negate { "NOT" } else { "" },
                if sqlite_ilike { "LIKE" } else { &operator }
            )
            .replace("  ", " "));
        }
        if self.take_word("IN") {
            if !matches!(self.peek(), FilterToken::LParen) {
                return Err(self.invalid());
            }
            self.position += 1;
            let mut values = Vec::new();
            loop {
                values.push(self.parse_primary()?);
                if !matches!(self.peek(), FilterToken::Comma) {
                    break;
                }
                self.position += 1;
            }
            if !matches!(self.peek(), FilterToken::RParen) || values.is_empty() {
                return Err(self.invalid());
            }
            self.position += 1;
            left = format!(
                "({left} {}IN ({}))",
                if negate { "NOT " } else { "" },
                values.join(", ")
            );
            return Ok(left);
        }
        if negate {
            return Err(self.invalid());
        }
        Ok(left)
    }

    fn parse_primary(&mut self) -> Result<String, String> {
        match self.next() {
            FilterToken::Identifier(name, _) if matches!(self.peek(), FilterToken::LParen) => {
                self.parse_function(name)
            }
            FilterToken::Identifier(name, _) => {
                if !self.fields.contains(name.as_str()) {
                    return Err("筛选表达式引用了当前图层不存在的字段".into());
                }
                Ok(sql_identifier(&name))
            }
            FilterToken::String(value) => Ok(match self.dialect {
                FilterDialect::Postgres => {
                    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
                }
                FilterDialect::Sqlite => format!("'{}'", value.replace('\'', "''")),
            }),
            FilterToken::Number(value) => Ok(value),
            FilterToken::Word(word) if word.eq_ignore_ascii_case("NULL") => Ok("NULL".into()),
            FilterToken::Word(word) if word.eq_ignore_ascii_case("TRUE") => Ok("TRUE".into()),
            FilterToken::Word(word) if word.eq_ignore_ascii_case("FALSE") => Ok("FALSE".into()),
            FilterToken::Word(word) => Err(format!(
                "筛选表达式不允许关键字 {}",
                word.to_ascii_uppercase()
            )),
            FilterToken::LParen => self.with_depth(|parser| {
                let expression = parser.parse_or()?;
                if !matches!(parser.peek(), FilterToken::RParen) {
                    return Err(parser.invalid());
                }
                parser.position += 1;
                Ok(format!("({expression})"))
            }),
            _ => Err(self.invalid()),
        }
    }

    fn parse_function(&mut self, function: String) -> Result<String, String> {
        let function = function.to_ascii_lowercase();
        if !matches!(
            function.as_str(),
            "left" | "right" | "lower" | "upper" | "trim" | "length" | "coalesce"
        ) {
            return Err("筛选表达式包含不支持的函数".into());
        }
        self.with_depth(|parser| {
            if !matches!(parser.peek(), FilterToken::LParen) {
                return Err(parser.invalid());
            }
            parser.position += 1;
            let mut args = Vec::new();
            if !matches!(parser.peek(), FilterToken::RParen) {
                loop {
                    args.push(parser.parse_or()?);
                    if !matches!(parser.peek(), FilterToken::Comma) {
                        break;
                    }
                    parser.position += 1;
                }
            }
            if !matches!(parser.peek(), FilterToken::RParen) {
                return Err(parser.invalid());
            }
            parser.position += 1;
            let valid_arity = match function.as_str() {
                "left" | "right" => args.len() == 2,
                "coalesce" => !args.is_empty(),
                _ => args.len() == 1,
            };
            if !valid_arity {
                return Err("筛选函数参数数量不正确".into());
            }
            if parser.dialect == FilterDialect::Sqlite {
                match function.as_str() {
                    "left" => return Ok(format!(
                        "(CASE WHEN ({}) < 0 THEN substr({}, 1, length({}) + ({})) ELSE substr({}, 1, ({})) END)",
                        args[1], args[0], args[0], args[1], args[0], args[1]
                    )),
                    "right" => return Ok(format!(
                        "(CASE WHEN ({}) = 0 THEN '' WHEN ({}) < 0 THEN substr({}, 1 - ({})) ELSE substr({}, -({})) END)",
                        args[1], args[1], args[0], args[1], args[0], args[1]
                    )),
                    _ => {}
                }
            }
            Ok(format!("{function}({})", args.join(", ")))
        })
    }

    fn with_depth<T>(
        &mut self,
        parse: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<T, String> {
        if self.depth >= 64 {
            return Err("筛选表达式嵌套超过 64 层安全上限".into());
        }
        self.depth += 1;
        let result = parse(self);
        self.depth -= 1;
        result
    }

    fn take_word(&mut self, expected: &str) -> bool {
        if matches!(self.peek(), FilterToken::Word(word) if word.eq_ignore_ascii_case(expected)) {
            self.position += 1;
            true
        } else {
            false
        }
    }
    fn peek(&self) -> &FilterToken {
        self.tokens.get(self.position).unwrap_or(&FilterToken::End)
    }
    fn next(&mut self) -> FilterToken {
        let token = self.peek().clone();
        self.position += 1;
        token
    }
    fn invalid(&self) -> String {
        let _ = self.input;
        "筛选表达式无效或包含不支持的 SQL 语法".into()
    }
}

fn tokenize_filter_expression(input: &str) -> Result<Vec<FilterToken>, String> {
    let chars = input.chars().collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if character.is_whitespace() {
            index += 1;
            continue;
        }
        if character == ';'
            || (character == '-' && chars.get(index + 1) == Some(&'-'))
            || (character == '/' && chars.get(index + 1) == Some(&'*'))
            || character == '.'
        {
            return Err("筛选表达式包含不允许的 SQL 标记".into());
        }
        if character == '\'' {
            index += 1;
            let mut value = String::new();
            let mut closed = false;
            while index < chars.len() {
                if chars[index] == '\'' {
                    if chars.get(index + 1) == Some(&'\'') {
                        value.push('\'');
                        index += 2;
                    } else {
                        index += 1;
                        closed = true;
                        break;
                    }
                } else {
                    value.push(chars[index]);
                    index += 1;
                }
            }
            if !closed {
                return Err("筛选表达式中的字符串未闭合".into());
            }
            tokens.push(FilterToken::String(value));
            continue;
        }
        if character == '"' {
            index += 1;
            let mut value = String::new();
            let mut closed = false;
            while index < chars.len() {
                if chars[index] == '"' {
                    if chars.get(index + 1) == Some(&'"') {
                        value.push('"');
                        index += 2;
                    } else {
                        index += 1;
                        closed = true;
                        break;
                    }
                } else {
                    value.push(chars[index]);
                    index += 1;
                }
            }
            if !closed || value.is_empty() {
                return Err("筛选表达式中的字段引用无效".into());
            }
            tokens.push(FilterToken::Identifier(value, true));
            continue;
        }
        if character.is_ascii_digit()
            || (character == '-'
                && chars
                    .get(index + 1)
                    .is_some_and(|next| next.is_ascii_digit()))
        {
            let start = index;
            index += 1;
            while index < chars.len() && (chars[index].is_ascii_digit() || chars[index] == '.') {
                index += 1;
            }
            if index < chars.len() && matches!(chars[index], 'e' | 'E') {
                index += 1;
                if index < chars.len() && matches!(chars[index], '+' | '-') {
                    index += 1;
                }
                while index < chars.len() && chars[index].is_ascii_digit() {
                    index += 1;
                }
            }
            let number = chars[start..index].iter().collect::<String>();
            if number.parse::<f64>().is_err() {
                return Err("筛选表达式中的数字无效".into());
            }
            tokens.push(FilterToken::Number(number));
            continue;
        }
        if character == '_' || character == '$' || character.is_alphabetic() {
            let start = index;
            index += 1;
            while index < chars.len()
                && (chars[index] == '_' || chars[index] == '$' || chars[index].is_alphanumeric())
            {
                index += 1;
            }
            let word = chars[start..index].iter().collect::<String>();
            if matches!(
                word.to_ascii_uppercase().as_str(),
                "AND"
                    | "OR"
                    | "NOT"
                    | "IS"
                    | "NULL"
                    | "LIKE"
                    | "ILIKE"
                    | "IN"
                    | "TRUE"
                    | "FALSE"
                    | "SELECT"
                    | "FROM"
                    | "UNION"
                    | "EXISTS"
            ) {
                if matches!(
                    word.to_ascii_uppercase().as_str(),
                    "SELECT" | "FROM" | "UNION" | "EXISTS"
                ) {
                    return Err("筛选表达式不允许查询、子查询或集合操作".into());
                }
                tokens.push(FilterToken::Word(word));
            } else {
                tokens.push(FilterToken::Identifier(word, false));
            }
            continue;
        }
        match character {
            '(' => {
                tokens.push(FilterToken::LParen);
                index += 1;
            }
            ')' => {
                tokens.push(FilterToken::RParen);
                index += 1;
            }
            ',' => {
                tokens.push(FilterToken::Comma);
                index += 1;
            }
            '=' => {
                tokens.push(FilterToken::Operator("="));
                index += 1;
            }
            '!' | '<' | '>' if chars.get(index + 1) == Some(&'=') => {
                tokens.push(FilterToken::Operator(if character == '!' {
                    "!="
                } else if character == '<' {
                    "<="
                } else {
                    ">="
                }));
                index += 2;
            }
            '<' if chars.get(index + 1) == Some(&'>') => {
                tokens.push(FilterToken::Operator("<>"));
                index += 2;
            }
            '<' => {
                tokens.push(FilterToken::Operator("<"));
                index += 1;
            }
            '>' => {
                tokens.push(FilterToken::Operator(">"));
                index += 1;
            }
            _ => return Err("筛选表达式包含不支持的字符或 SQL 语法".into()),
        }
    }
    tokens.push(FilterToken::End);
    if tokens.len() > MAX_FILTER_TOKENS {
        return Err("筛选表达式复杂度超过安全上限".into());
    }
    Ok(tokens)
}

fn import_raster_blocking(
    app: &RuntimeContext,
    state: &GisState,
    path: String,
) -> Result<Value, String> {
    let runtime = GisRuntime::resolve(app)?;
    let source = checked_input_path(&path, &["tif", "tiff", "vrt", "img"])?;
    let info = run_tool(
        &runtime,
        "gdalinfo",
        [OsString::from("-json"), source.as_os_str().to_owned()],
    )?;
    let info: Value = serde_json::from_slice(&info.stdout)
        .map_err(|error| format!("GDAL 栅格元数据解析失败：{error}"))?;
    let source_crs = info
        .get("coordinateSystem")
        .and_then(crs_label)
        .ok_or_else(|| "栅格未声明坐标系，无法安全定位".to_string())?;
    let bounds =
        wgs84_bounds(&info).ok_or_else(|| "栅格缺少可转换为 WGS84 的地理定位范围".to_string())?;
    let mut rasters = state
        .rasters
        .lock()
        .map_err(|_| "栅格登记表不可用".to_string())?;
    if rasters.len() >= MAX_RASTERS {
        return Err(format!("当前最多登记 {MAX_RASTERS} 个栅格数据源"));
    }
    let id = unique_id(&source);
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("raster")
        .to_string();
    rasters.insert(
        id.clone(),
        RasterSource {
            path: source.clone(),
        },
    );
    Ok(
        json!({ "id": id, "name": name, "path": source, "bounds": bounds, "source_crs": source_crs }),
    )
}

fn raster_tile_blocking(
    app: &RuntimeContext,
    state: &GisState,
    id: String,
    z: u32,
    x: u32,
    y: u32,
) -> Result<Vec<u8>, String> {
    if z > 22 {
        return Err("瓦片缩放级别不得超过 22".into());
    }
    let side = 1_u32 << z;
    if x >= side || y >= side {
        return Err("瓦片坐标超出该缩放级别范围".into());
    }
    let key = TileKey {
        id: id.clone(),
        z,
        x,
        y,
    };
    if let Some(tile) = state.cache_get(&key) {
        return Ok(tile.as_ref().clone());
    }
    let _permit = state.acquire_tile()?;
    if let Some(tile) = state.cache_get(&key) {
        return Ok(tile.as_ref().clone());
    }
    let source = state
        .rasters
        .lock()
        .map_err(|_| "栅格登记表不可用".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("未知栅格数据源：{id}"))?;
    let runtime = GisRuntime::resolve(app)?;
    let half_world = 20_037_508.342_789_244_f64;
    let tile_span = (2.0 * half_world) / f64::from(side);
    let min_x = -half_world + f64::from(x) * tile_span;
    let max_x = min_x + tile_span;
    let max_y = half_world - f64::from(y) * tile_span;
    let min_y = max_y - tile_span;
    let temp = make_temp_dir("road-gis-tile")?;
    let warped = temp.0.join("window.tif");
    let args = [
        OsString::from("-q"),
        OsString::from("-overwrite"),
        OsString::from("-of"),
        OsString::from("GTiff"),
        OsString::from("-t_srs"),
        OsString::from("EPSG:3857"),
        OsString::from("-dstalpha"),
        OsString::from("-wm"),
        OsString::from("64"),
        OsString::from("-te_srs"),
        OsString::from("EPSG:3857"),
        OsString::from("-te"),
        os_num(min_x),
        os_num(min_y),
        os_num(max_x),
        os_num(max_y),
        OsString::from("-ts"),
        OsString::from("256"),
        OsString::from("256"),
        source.path.as_os_str().to_owned(),
        warped.as_os_str().to_owned(),
    ];
    run_tool(&runtime, "gdalwarp", args)?;
    let output = run_tool(
        &runtime,
        "gdal_translate",
        [
            OsString::from("-q"),
            OsString::from("-of"),
            OsString::from("PNG"),
            warped.as_os_str().to_owned(),
            OsString::from("/vsistdout/"),
        ],
    )?;
    if output.stdout.len() > 16 * 1024 * 1024 || !output.stdout.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("GDAL 未生成有效的 PNG 栅格瓦片".into());
    }
    state.cache_insert(key, output.stdout.clone());
    Ok(output.stdout)
}

fn export_geopackage_blocking(
    app: &RuntimeContext,
    path: String,
    layers: Value,
) -> Result<Value, String> {
    let runtime = GisRuntime::resolve(app)?;
    let destination = PathBuf::from(path);
    if destination.exists() {
        return Err("导出目标已存在；为保护用户数据，不会覆盖现有文件".into());
    }
    if !matches!(extension(&destination).as_str(), "gpkg") {
        return Err("GeoPackage 导出目标必须使用 .gpkg 扩展名".into());
    }
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err(format!("导出目录不存在：{}", parent.display()));
    }
    let layers = layers
        .as_array()
        .ok_or_else(|| "layers 必须是数组".to_string())?;
    if layers.is_empty() || layers.len() > 200 {
        return Err("GeoPackage 至少需要一个图层且最多支持 200 层".into());
    }
    let temp = make_temp_dir_in(parent, "road-gis-export")?;
    let staged = temp.0.join("output.gpkg");
    let mut names = Vec::new();
    for (index, layer) in layers.iter().enumerate() {
        let name = layer
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("第 {} 个图层缺少名称", index + 1))?;
        let crs = layer
            .get("crs")
            .and_then(Value::as_str)
            .filter(|crs| !crs.trim().is_empty())
            .ok_or_else(|| format!("图层 {name} 缺少 CRS 标记"))?;
        let collection = layer
            .get("collection")
            .filter(|value| value.get("type").and_then(Value::as_str) == Some("FeatureCollection"))
            .ok_or_else(|| format!("图层 {name} 的 collection 不是 FeatureCollection"))?;
        let geometry_report = validate_geometry_blocking(app, collection, crs)?;
        if geometry_report.get("valid").and_then(Value::as_bool) != Some(true) {
            return Err(format!(
                "图层 {name} 包含无效几何：{}",
                serde_json::to_string(
                    &geometry_report
                        .get("invalid_features")
                        .unwrap_or(&Value::Null)
                )
                .unwrap_or_else(|_| "无法序列化问题位置".into())
            ));
        }
        let json_path = temp.0.join(format!("layer-{index}.geojson"));
        let serialized = serde_json::to_vec(collection).map_err(|error| error.to_string())?;
        if serialized.len() > 128 * 1024 * 1024 {
            return Err(format!("图层 {name} 的 GeoJSON 超过 128 MiB 上限"));
        }
        fs::write(&json_path, serialized)
            .map_err(|error| format!("无法写入临时图层 {name}：{error}"))?;
        let mut args = vec![
            OsString::from("-f"),
            OsString::from("GPKG"),
            staged.as_os_str().to_owned(),
            json_path.into_os_string(),
            OsString::from("-nln"),
            OsString::from(clean_layer_name(name)?),
            OsString::from("-a_srs"),
            OsString::from(crs),
        ];
        if index > 0 {
            args.push(OsString::from("-update"));
        }
        run_tool(&runtime, "ogr2ogr", args)?;
        names.push(name.to_string());
    }
    if destination.exists() {
        return Err("导出期间目标文件已出现；已保留该文件且未提交结果".into());
    }
    fs::rename(&staged, &destination)
        .map_err(|error| format!("GeoPackage 写入成功但无法原子提交到目标路径：{error}"))?;
    Ok(json!({ "path": destination, "layers": names, "layer_count": names.len() }))
}

fn validate_geometry_blocking(
    app: &RuntimeContext,
    collection: &Value,
    crs: &str,
) -> Result<Value, String> {
    if crs.trim().is_empty() {
        return Err("几何有效性检查需要明确的 CRS".into());
    }
    if collection.get("type").and_then(Value::as_str) != Some("FeatureCollection") {
        return Err("collection 必须是 GeoJSON FeatureCollection".into());
    }
    let features = collection
        .get("features")
        .and_then(Value::as_array)
        .ok_or_else(|| "FeatureCollection 缺少 features 数组".to_string())?;
    if features.len() > 20_000 {
        return Err("单次几何有效性检查最多支持 20,000 个要素".into());
    }
    let serialized = serde_json::to_vec(collection).map_err(|error| error.to_string())?;
    if serialized.len() > 128 * 1024 * 1024 {
        return Err("待检查 GeoJSON 超过 128 MiB 上限".into());
    }
    let runtime = GisRuntime::resolve(app)?;
    let temp = make_temp_dir("road-gis-validity")?;
    let geojson = temp.0.join("input.geojson");
    let gpkg = temp.0.join("validation.gpkg");
    fs::write(&geojson, serialized).map_err(|error| format!("无法写入临时 GeoJSON：{error}"))?;
    run_tool(
        &runtime,
        "ogr2ogr",
        [
            OsString::from("-f"),
            OsString::from("GPKG"),
            gpkg.as_os_str().to_owned(),
            geojson.as_os_str().to_owned(),
            OsString::from("-nln"),
            OsString::from("validation"),
            OsString::from("-a_srs"),
            OsString::from(crs),
        ],
    )?;
    let sql = "SELECT fid, ST_IsValid(geom) AS is_valid, ST_IsValidReason(geom) AS reason FROM validation ORDER BY fid";
    let output = run_tool(
        &runtime,
        "ogrinfo",
        [
            OsString::from("-ro"),
            OsString::from("-json"),
            OsString::from("-features"),
            OsString::from("-geom=NO"),
            OsString::from("-dialect"),
            OsString::from("SQLite"),
            OsString::from("-sql"),
            OsString::from(sql),
            gpkg.into_os_string(),
        ],
    )?;
    let result: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("GEOS 有效性结果解析失败：{error}"))?;
    let rows = result
        .get("features")
        .and_then(Value::as_array)
        .or_else(|| {
            result
                .get("layers")
                .and_then(Value::as_array)
                .and_then(|layers| layers.first()?.get("features")?.as_array())
        })
        .ok_or_else(|| {
            "OGR SQLite 未返回 GEOS 检查结果；请确认 GDAL 带 SQLite/GEOS 支持".to_string()
        })?;
    let mut invalid_features = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let properties = row.get("properties").unwrap_or(row);
        let is_valid = properties
            .get("is_valid")
            .or_else(|| properties.get("ST_IsValid"))
            .and_then(Value::as_bool)
            .or_else(|| {
                properties
                    .get("is_valid")
                    .and_then(Value::as_i64)
                    .map(|value| value != 0)
            })
            .or_else(|| {
                properties
                    .get("ST_IsValid")
                    .and_then(Value::as_i64)
                    .map(|value| value != 0)
            });
        if is_valid != Some(true) {
            invalid_features.push(json!({
                "index": index,
                "id": properties.get("fid").cloned().or_else(|| row.get("fid").cloned()).or_else(|| row.get("id").cloned()).unwrap_or(Value::Null),
                "reason": properties.get("reason").or_else(|| properties.get("ST_IsValidReason")).cloned().unwrap_or_else(|| json!("GEOS 判定几何无效")),
            }));
        }
    }
    if rows.len() != features.len() {
        return Err(format!(
            "GEOS 返回 {} 条检查记录，但输入包含 {} 个要素",
            rows.len(),
            features.len()
        ));
    }
    Ok(json!({
        "valid": invalid_features.is_empty(),
        "feature_count": features.len(),
        "invalid_features": invalid_features,
    }))
}

struct GisRuntime {
    root: PathBuf,
}

impl GisRuntime {
    fn resolve(app: &RuntimeContext) -> Result<Self, String> {
        let mut candidates = Vec::new();
        if let Some(path) = std::env::var_os("ROAD_GIS_RUNTIME") {
            candidates.push(PathBuf::from(path));
        }
        candidates.extend(app.gis_candidates());
        let root = candidates
            .into_iter()
            .find(|path| path.join("bin").is_dir())
            .ok_or_else(|| {
                "找不到 GDAL/PROJ 运行资源；请准备 resources/gis/bin，或设置 ROAD_GIS_RUNTIME"
                    .to_string()
            })?;
        Ok(Self { root })
    }

    fn executable(&self, program: &str) -> PathBuf {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        self.root.join("bin").join(format!("{program}{suffix}"))
    }
}

/// 通过稳定的 JSON 参数调用共享 GIS 能力。
pub fn dispatch(
    command: &str,
    args: &Value,
    context: &RuntimeContext,
    state: &GisState,
) -> Result<Value, String> {
    let string = |camel: &str, snake: &str| -> Result<String, String> {
        args.get(camel)
            .or_else(|| args.get(snake))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("缺少参数 {camel}"))
    };
    let value = |camel: &str, snake: &str| -> Result<Value, String> {
        args.get(camel)
            .or_else(|| args.get(snake))
            .cloned()
            .ok_or_else(|| format!("缺少参数 {camel}"))
    };
    match command {
        "list_vector_layers" | "listVectorLayers" => {
            list_vector_layers_blocking(context, string("path", "path")?)
        }
        "import_vector" | "importVector" => import_vector_blocking(
            context,
            string("path", "path")?,
            args.get("layerName")
                .or_else(|| args.get("layer_name"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        ),
        "query_vector_data" | "queryVectorData" => query_vector_data_blocking(
            context,
            value("source", "source")?,
            value("query", "query")?,
        ),
        "import_remote_vector" | "importRemoteVector" => {
            import_remote_vector_blocking(context, value("connection", "connection")?)
        }
        "list_remote_databases" | "listRemoteDatabases" => {
            list_remote_databases_blocking(context, value("connection", "connection")?)
        }
        "list_remote_layers" | "listRemoteLayers" => {
            list_remote_layers_blocking(context, value("connection", "connection")?)
        }
        "test_remote_connection" | "testRemoteConnection" => {
            test_remote_connection_blocking(context, &value("connection", "connection")?)
        }
        "get_database_capabilities" | "getDatabaseCapabilities" => {
            let runtime = GisRuntime::resolve(context)?;
            let output = run_tool(&runtime, "ogrinfo", [OsString::from("--formats")])?;
            Ok(database_capabilities(&String::from_utf8_lossy(
                &output.stdout,
            )))
        }
        "import_raster" | "importRaster" => {
            import_raster_blocking(context, state, string("path", "path")?)
        }
        "raster_tile" | "rasterTile" => {
            let bytes = raster_tile_blocking(
                context,
                state,
                string("id", "id")?,
                u32_arg(args, "z")?,
                u32_arg(args, "x")?,
                u32_arg(args, "y")?,
            )?;
            Ok(json!({"encoding":"base64","data":base64_encode(&bytes)}))
        }
        "export_geopackage" | "exportGeoPackage" => {
            export_geopackage_blocking(context, string("path", "path")?, value("layers", "layers")?)
        }
        "crs_definition" | "crsDefinition" => {
            let rt = GisRuntime::resolve(context)?;
            let output = run_tool(
                &rt,
                "gdalsrsinfo",
                [
                    OsString::from("-o"),
                    OsString::from("proj4"),
                    OsString::from(string("crs", "crs")?),
                ],
            )?;
            Ok(Value::String(
                String::from_utf8_lossy(&output.stdout).trim().to_string(),
            ))
        }
        "validate_geometry" | "validateGeometry" => validate_geometry_blocking(
            context,
            &value("collection", "collection")?,
            &string("crs", "crs")?,
        ),
        "transform_collection" | "transformCollection" => transform_collection(
            context,
            value("collection", "collection")?,
            &string("sourceCrs", "source_crs")?,
            &string("targetCrs", "target_crs")?,
        ),
        _ => Err(format!("未知 GIS 命令：{command}")),
    }
}

fn u32_arg(args: &Value, key: &str) -> Result<u32, String> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| format!("参数 {key} 无效"))
}
fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | (((*c.get(1).unwrap_or(&0)) as u32) << 8)
            | (*c.get(2).unwrap_or(&0) as u32);
        for i in 0..4 {
            out.push(if i > c.len() {
                '='
            } else {
                T[((n >> (18 - 6 * i)) & 63) as usize] as char
            });
        }
    }
    out
}

fn transform_collection(
    context: &RuntimeContext,
    collection: Value,
    source_crs: &str,
    target_crs: &str,
) -> Result<Value, String> {
    if collection
        .get("type")
        .and_then(Value::as_str)
        .is_none_or(|t| t != "FeatureCollection")
        || collection
            .get("features")
            .and_then(Value::as_array)
            .is_none_or(|f| f.len() > 100_000)
    {
        return Err("collection 必须是最多 100000 个要素的 FeatureCollection".into());
    }
    let runtime = GisRuntime::resolve(context)?;
    let dir = tempfile::tempdir().map_err(|e| format!("创建坐标转换临时目录失败：{e}"))?;
    let input = dir.path().join("input.geojson");
    let output = dir.path().join("output.geojson");
    let bytes = serde_json::to_vec(&collection).map_err(|e| format!("GeoJSON 编码失败：{e}"))?;
    if bytes.len() > MAX_VECTOR_JSON_BYTES {
        return Err("坐标转换输入超过大小上限".into());
    }
    let geometry_collection = geometry_transform_collection(&collection)?;
    let geometry_bytes = serde_json::to_vec(&geometry_collection)
        .map_err(|e| format!("GeoJSON 几何编码失败：{e}"))?;
    if geometry_bytes.len() > MAX_VECTOR_JSON_BYTES {
        return Err("坐标转换输入超过大小上限".into());
    }
    fs::write(&input, geometry_bytes).map_err(|e| format!("写入临时 GeoJSON 失败：{e}"))?;
    run_tool(
        &runtime,
        "ogr2ogr",
        [
            OsString::from("-f"),
            OsString::from("GeoJSON"),
            output.clone().into_os_string(),
            input.into_os_string(),
            OsString::from("-s_srs"),
            OsString::from(source_crs),
            OsString::from("-t_srs"),
            OsString::from(target_crs),
        ],
    )?;
    let metadata = fs::metadata(&output).map_err(|e| format!("读取转换结果失败：{e}"))?;
    if metadata.len() > MAX_VECTOR_JSON_BYTES as u64 {
        return Err("坐标转换结果超过大小上限".into());
    }
    let converted: Value =
        serde_json::from_slice(&fs::read(output).map_err(|e| format!("读取转换结果失败：{e}"))?)
            .map_err(|e| format!("转换结果 JSON 无效：{e}"))?;
    let mut converted = merge_transformed_geometries(&collection, &converted)?;
    let target_upper = target_crs.trim().to_ascii_uppercase();
    let is_wgs84 = matches!(target_upper.as_str(), "EPSG:4326" | "OGC:CRS84" | "CRS84");
    converted["collection_crs"] = json!(if is_wgs84 { "EPSG:4326" } else { target_crs });
    if is_wgs84 {
        converted
            .as_object_mut()
            .expect("GeoJSON 顶层必须是对象")
            .remove("crs");
    } else {
        converted["crs"] = json!({"type":"name","properties":{"name":target_crs}});
    }
    let result_bytes =
        serde_json::to_vec(&converted).map_err(|e| format!("坐标转换结果编码失败：{e}"))?;
    if result_bytes.len() > MAX_VECTOR_JSON_BYTES {
        return Err("坐标转换结果超过大小上限".into());
    }
    Ok(converted)
}

fn geometry_transform_collection(collection: &Value) -> Result<Value, String> {
    let source_features = collection
        .get("features")
        .and_then(Value::as_array)
        .ok_or("输入缺少 features")?;
    let features = source_features
        .iter()
        .enumerate()
        .map(|(index, feature)| {
            json!({
                "type": "Feature",
                "id": index,
                "properties": {"__transform_index": index},
                "geometry": feature.get("geometry").cloned().unwrap_or(Value::Null)
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"type":"FeatureCollection", "features":features}))
}

fn merge_transformed_geometries(source: &Value, transformed: &Value) -> Result<Value, String> {
    if transformed.get("type").and_then(Value::as_str) != Some("FeatureCollection") {
        return Err("GDAL 转换结果不是 FeatureCollection".into());
    }
    let source_features = source
        .get("features")
        .and_then(Value::as_array)
        .ok_or("输入缺少 features")?;
    let transformed_features = transformed
        .get("features")
        .and_then(Value::as_array)
        .ok_or("GDAL 转换结果缺少 features")?;
    if transformed_features.len() != source_features.len() {
        return Err("坐标转换改变了要素数量".into());
    }
    let mut merged_features = Vec::with_capacity(source_features.len());
    for (index, (source_feature, transformed_feature)) in
        source_features.iter().zip(transformed_features).enumerate()
    {
        let expected_index = index as u64;
        if transformed_feature
            .get("type")
            .and_then(Value::as_str)
            .is_none_or(|t| t != "Feature")
            || transformed_feature.get("geometry").is_none()
        {
            return Err(format!("坐标转换结果第 {index} 个要素缺少几何字段"));
        }
        if transformed_feature.get("id").and_then(Value::as_u64) != Some(expected_index) {
            return Err(format!("坐标转换结果第 {index} 个要素的索引 ID 发生变化"));
        }
        if transformed_feature
            .get("properties")
            .and_then(|properties| properties.get("__transform_index"))
            .and_then(Value::as_u64)
            != Some(expected_index)
        {
            return Err(format!("坐标转换结果第 {index} 个要素的顺序标记发生变化"));
        }
        let mut merged_feature = source_feature.clone();
        let feature_object = merged_feature
            .as_object_mut()
            .ok_or_else(|| format!("输入第 {index} 个要素不是对象"))?;
        feature_object.insert("geometry".into(), transformed_feature["geometry"].clone());
        merged_features.push(merged_feature);
    }
    let mut merged = source.clone();
    let merged_object = merged
        .as_object_mut()
        .ok_or("输入 FeatureCollection 不是对象")?;
    merged_object.insert("features".into(), Value::Array(merged_features));
    if let (Some(source_map), Some(target_map)) = (source.as_object(), merged.as_object_mut()) {
        for (key, value) in source_map {
            if !["type", "features", "crs"].contains(&key.as_str()) {
                target_map
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
        }
    }
    Ok(merged)
}

struct ToolOutput {
    stdout: Vec<u8>,
}

fn run_tool<I>(runtime: &GisRuntime, program: &str, args: I) -> Result<ToolOutput, String>
where
    I: IntoIterator<Item = OsString>,
{
    run_tool_with_deadline(runtime, program, args, None)
}

fn run_tool_with_deadline<I>(
    runtime: &GisRuntime,
    program: &str,
    args: I,
    deadline: Option<std::time::Duration>,
) -> Result<ToolOutput, String>
where
    I: IntoIterator<Item = OsString>,
{
    let executable = runtime.executable(program);
    if !executable.is_file() {
        return Err(format!("GIS 运行资源缺少 {}", executable.display()));
    }
    let mut command = Command::new(&executable);
    command
        .args(args)
        .env("GDAL_DATA", runtime.root.join("share").join("gdal"));
    command.env("PROJ_DATA", runtime.root.join("share").join("proj"));
    let driver_path = runtime.root.join("plugins");
    command.env(
        "GDAL_DRIVER_PATH",
        if driver_path.is_dir() {
            driver_path.as_os_str()
        } else {
            std::ffi::OsStr::new("disable")
        },
    );
    command.env("GDAL_CACHEMAX", "64");
    command.env("GDAL_HTTP_TIMEOUT", "20");
    command.env("GDAL_HTTP_CONNECTTIMEOUT", "10");
    command.env("MYSQL_TIMEOUT", "20");
    let mut path_parts = vec![runtime.root.join("bin")];
    #[cfg(windows)]
    path_parts.push(
        PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| OsString::from(r"C:\Windows")))
            .join("System32"),
    );
    #[cfg(not(windows))]
    path_parts.extend([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    if let Some(client_bin) = std::env::var_os("ROAD_GIS_CLIENT_BIN") {
        path_parts.extend(std::env::split_paths(&client_bin));
    }
    if let Some(oracle_home) = std::env::var_os("ORACLE_HOME") {
        let home = PathBuf::from(oracle_home);
        path_parts.push(home.join("bin"));
        path_parts.push(home);
    }
    if let Ok(path_value) = std::env::join_paths(path_parts) {
        command.env("PATH", path_value);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 {}：{error}", executable.display()))?;
    let stdout = child.stdout.take().expect("stdout 已配置为管道");
    let stderr = child.stderr.take().expect("stderr 已配置为管道");
    let out_reader = std::thread::spawn(move || read_bounded(stdout, MAX_TOOL_STDOUT_BYTES));
    let err_reader = std::thread::spawn(move || read_bounded(stderr, MAX_TOOL_STDERR_BYTES));
    let started = std::time::Instant::now();
    let mut timed_out = false;
    let status = if let Some(limit) = deadline {
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("检查 GIS 工具状态失败：{error}"))?
            {
                break status;
            }
            if started.elapsed() >= limit {
                // 只结束本次命令的子进程，不接触数据库服务；排空管道后返回超时分类。
                timed_out = true;
                let _ = child.kill();
                break child
                    .wait()
                    .map_err(|error| format!("结束超时 GIS 命令失败：{error}"))?;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    } else {
        child
            .wait()
            .map_err(|error| format!("等待 {} 结束失败：{error}", executable.display()))?
    };
    let out = out_reader
        .join()
        .map_err(|_| "读取 GIS 工具输出线程失败".to_string())??;
    let err = err_reader
        .join()
        .map_err(|_| "读取 GIS 工具错误线程失败".to_string())??;
    if timed_out {
        return Err("GIS command timeout：本次只读命令超过等待时限".into());
    }
    if out.1 || err.1 {
        return Err(format!(
            "{} 输出超过安全上限",
            executable.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    if !status.success() {
        let details = String::from_utf8_lossy(&err.0);
        return Err(format!(
            "{} 执行失败（{}）：{}",
            executable.file_name().unwrap_or_default().to_string_lossy(),
            status,
            details.trim()
        ));
    }
    Ok(ToolOutput { stdout: out.0 })
}

fn read_bounded<R: Read>(mut reader: R, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    let mut exceeded = false;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取 GIS 工具管道失败：{error}"))?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(retained.len());
        let keep = remaining.min(count);
        retained.extend_from_slice(&buffer[..keep]);
        exceeded |= keep < count;
    }
    Ok((retained, exceeded))
}

fn checked_input_path(path: &str, allowed_extensions: &[&str]) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let canonical = dunce::canonicalize(&path)
        .map_err(|error| format!("无法读取输入文件 {}：{error}", path.display()))?;
    if !canonical.is_file() {
        return Err(format!("输入路径不是普通文件：{}", canonical.display()));
    }
    let ext = extension(&canonical);
    if !allowed_extensions.contains(&ext.as_str()) {
        return Err(format!("不支持的文件类型 .{ext}"));
    }
    Ok(canonical)
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn find_crs(layer: &Value) -> Option<String> {
    layer
        .get("geometryFields")?
        .as_array()?
        .iter()
        .find_map(|field| field.get("coordinateSystem").and_then(crs_label))
}

#[cfg(test)]
fn find_geometry_crs(layer: &Value, geometry_column: &str) -> Option<String> {
    layer
        .get("geometryFields")?
        .as_array()?
        .iter()
        .find(|field| field.get("name").and_then(Value::as_str) == Some(geometry_column))
        .and_then(|field| field.get("coordinateSystem"))
        .and_then(crs_label)
}

fn build_postgis_import_sql(
    layer: &Value,
    schema: &str,
    table: &str,
    selected_geometry: &str,
    validation_field: Option<&str>,
) -> Result<String, String> {
    let geometry_fields = layer
        .get("geometryFields")
        .and_then(Value::as_array)
        .ok_or_else(|| "所选 PostGIS 表未声明几何列".to_string())?;
    if !geometry_fields
        .iter()
        .any(|field| field.get("name").and_then(Value::as_str) == Some(selected_geometry))
    {
        return Err("所选 PostGIS 几何列在表元数据中不存在，请刷新目录后重试".into());
    }
    let geometry_names = geometry_fields
        .iter()
        .filter_map(|field| field.get("name").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    let mut columns = vec![sql_identifier(selected_geometry)];
    let fields = layer
        .get("fields")
        .and_then(Value::as_array)
        .ok_or_else(|| "PostGIS 表元数据未返回属性字段，无法安全构建导入查询".to_string())?;
    for field in fields {
        let Some(name) = field.get("name").and_then(Value::as_str) else {
            continue;
        };
        if !geometry_names.contains(name) {
            columns.push(sql_identifier(name));
        }
    }
    if let Some(field) = validation_field {
        let extension_schema = layer
            .get("extension_schema")
            .and_then(Value::as_str)
            .ok_or_else(|| "PostGIS 空间扩展目录不可用".to_string())?;
        columns.push(format!(
            "{}.ST_SRID({}) AS {}",
            sql_identifier(extension_schema),
            sql_identifier(selected_geometry),
            sql_identifier(field)
        ));
    }
    Ok(format!(
        "SELECT {} FROM {}.{}",
        columns.join(", "),
        sql_identifier(schema),
        sql_identifier(table)
    ))
}

// 校验字段只存在于本次有界读取中，不覆盖业务字段，也不进入工程属性。
fn postgis_validation_field(layer: &Value) -> String {
    let mut candidate = "__road_import_srid".to_string();
    let names = ["fields", "geometryFields"]
        .into_iter()
        .filter_map(|key| layer.get(key).and_then(Value::as_array))
        .flatten()
        .filter_map(|field| field.get("name").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    while names.contains(candidate.as_str()) {
        candidate.push('_');
    }
    candidate
}

fn validate_postgis_batch_srid(
    features: &mut [Value],
    field: &str,
    expected_srid: i64,
) -> Result<(), String> {
    for feature in features {
        let has_geometry = feature
            .get("geometry")
            .is_some_and(|geometry| !geometry.is_null());
        let properties = feature
            .get_mut("properties")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "PostGIS 要素缺少 SRID 校验属性".to_string())?;
        let srid = properties.remove(field).and_then(|value| value.as_i64());
        if has_geometry && srid != Some(expected_srid) {
            return Err(
                "本次读取的 PostGIS 要素包含不一致或未知的 SRID；请按 CRS 整理数据后再导入".into(),
            );
        }
    }
    Ok(())
}

fn crs_label(srs: &Value) -> Option<String> {
    let projjson = srs.get("projjson").unwrap_or(srs);
    let id = projjson.get("id").or_else(|| srs.get("id"));
    if let Some(id) = id {
        let authority = id.get("authority").and_then(Value::as_str);
        let code = id.get("code").and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_u64().map(|number| number.to_string()))
        });
        if let (Some(authority), Some(code)) = (authority, code) {
            return Some(format!("{authority}:{code}"));
        }
    }
    srs.get("wkt")
        .and_then(Value::as_str)
        .filter(|wkt| !wkt.trim().is_empty())
        .map(str::to_string)
}

fn wgs84_bounds(info: &Value) -> Option<[f64; 4]> {
    let coordinates = info.pointer("/wgs84Extent/coordinates")?.as_array()?;
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut found = false;
    fn visit(value: &Value, bounds: &mut [f64; 4], found: &mut bool) {
        if let Some(pair) = value
            .as_array()
            .filter(|items| items.len() >= 2 && items[0].is_number() && items[1].is_number())
        {
            if let (Some(x), Some(y)) = (pair[0].as_f64(), pair[1].as_f64()) {
                bounds[0] = bounds[0].min(x);
                bounds[1] = bounds[1].min(y);
                bounds[2] = bounds[2].max(x);
                bounds[3] = bounds[3].max(y);
                *found = true;
            }
        } else if let Some(items) = value.as_array() {
            for item in items {
                visit(item, bounds, found);
            }
        }
    }
    for item in coordinates {
        visit(item, &mut bounds, &mut found);
    }
    (found && bounds.iter().all(|value| value.is_finite())).then_some(bounds)
}

fn clean_layer_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 128 || trimmed.contains(['/', '\\', '\0']) {
        return Err("图层名不能为空、不得超过 128 字节且不能包含路径分隔符".into());
    }
    Ok(trimmed.to_string())
}

fn os_num(value: f64) -> OsString {
    OsString::from(format!("{value:.12}"))
}

fn make_temp_dir(prefix: &str) -> Result<TempDir, String> {
    make_temp_dir_in(&std::env::temp_dir(), prefix)
}

fn make_temp_dir_in(root: &Path, prefix: &str) -> Result<TempDir, String> {
    for _ in 0..8 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!("{prefix}-{}-{sequence}", std::process::id()));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(TempDir(path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建 GIS 临时目录：{error}")),
        }
    }
    Err("无法分配唯一的 GIS 临时目录".into())
}

fn unique_id(path: &Path) -> String {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "raster-{sequence}-{:x}",
        path.to_string_lossy()
            .bytes()
            .fold(0xcbf29ce484222325_u64, |hash, byte| (hash
                ^ u64::from(byte))
            .wrapping_mul(0x100000001b3))
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_postgis_import_sql, build_postgis_page_sql, collision_safe_field,
        connection_failure_message, connection_failure_message_for, connection_probe_result,
        connection_probe_sql, connection_schema, coordinate_array_is_wgs84, database_capabilities,
        feature_collection_coordinates_are_wgs84, find_geometry_crs, geometry_transform_collection,
        merge_transformed_geometries, mysql_probe_result, mysql_quote, odbc_value,
        postgis_crs_identifier, postgis_sample_srid_sql, postgis_validation_field,
        remote_layer_summaries, schema_probe_result, schema_probe_sql, sqlite_bbox_predicate,
        valid_http_url, validate_postgis_batch_srid, vector_capabilities, FilterDialect,
        FilterExpressionParser, RemoteReadOptions, RemoteSourcePlan, VectorQueryOptions,
        DEFAULT_REMOTE_READ_LIMIT,
    };
    use serde_json::json;

    #[test]
    fn transformed_collection_is_markable_only_when_coordinates_are_wgs84() {
        let collection = json!({
            "type":"FeatureCollection",
            "features":[
                {"type":"Feature","geometry":{"type":"LineString","coordinates":[[116.4,39.9,12.0],[116.5,40.0,13.0]]}},
                {"type":"Feature","geometry":{"type":"Point","coordinates":[-179.9,-89.9]}}
            ]
        });
        assert!(feature_collection_coordinates_are_wgs84(&collection));
        assert!(!coordinate_array_is_wgs84(&json!([
            [500000.0, 4400000.0],
            [500100.0, 4400100.0]
        ])));
        assert!(!coordinate_array_is_wgs84(&json!([[116.4, 91.0]])));
    }

    #[test]
    fn geometry_transform_merge_preserves_nested_null_and_heterogeneous_properties() {
        let source = json!({
            "type":"FeatureCollection",
            "collection_crs":"EPSG:32650",
            "custom_collection_member":{"kept":true},
            "features":[
                {
                    "type":"Feature", "id":"road-A", "custom_feature_member":[1,null],
                    "properties":{"route_id":"A", "template":{"widths":[3.5,3.25],"optional":null}},
                    "geometry":{"type":"Point","coordinates":[10.0,20.0]}
                },
                {
                    "type":"Feature", "id":42,
                    "properties":{"route_id":null,"other":[true,{"value":7}]},
                    "geometry":{"type":"Point","coordinates":[30.0,40.0]}
                }
            ]
        });

        let input = geometry_transform_collection(&source).unwrap();
        assert_eq!(input["features"][0]["id"], 0);
        assert_eq!(
            input["features"][0]["properties"],
            json!({"__transform_index":0})
        );
        assert_eq!(input["features"][1]["id"], 1);
        assert_eq!(
            input["features"][1]["properties"],
            json!({"__transform_index":1})
        );

        // 模拟 GDAL 返回值，其属性 schema 只包含索引，业务属性仍只从原要素读取。
        let transformed = json!({
            "type":"FeatureCollection",
            "features":[
                {"type":"Feature","id":0,"properties":{"__transform_index":0},
                    "geometry":{"type":"Point","coordinates":[100.0,200.0]}},
                {"type":"Feature","id":1,"properties":{"__transform_index":1},
                    "geometry":{"type":"Point","coordinates":[300.0,400.0]}}
            ]
        });
        let merged = merge_transformed_geometries(&source, &transformed).unwrap();
        assert_eq!(merged["features"][0]["id"], "road-A");
        assert_eq!(
            merged["features"][0]["properties"],
            source["features"][0]["properties"]
        );
        assert_eq!(
            merged["features"][0]["custom_feature_member"],
            json!([1, null])
        );
        assert_eq!(
            merged["features"][0]["geometry"]["coordinates"],
            json!([100.0, 200.0])
        );
        assert_eq!(merged["features"][1]["id"], 42);
        assert_eq!(
            merged["features"][1]["properties"],
            source["features"][1]["properties"]
        );
        assert_eq!(
            merged["features"][1]["geometry"]["coordinates"],
            json!([300.0, 400.0])
        );
        assert_eq!(merged["custom_collection_member"], json!({"kept":true}));
    }

    #[test]
    fn geometry_transform_merge_rejects_changed_index_id_or_feature_order() {
        let source = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","id":"original-A","properties":{"name":"A"},"geometry":{"type":"Point","coordinates":[1,2]}},
            {"type":"Feature","id":"original-B","properties":{"name":"B"},"geometry":{"type":"Point","coordinates":[3,4]}}
        ]});
        let transformed = json!({"type":"FeatureCollection","features":[
            {"type":"Feature","id":0,"properties":{"__transform_index":0},"geometry":{"type":"Point","coordinates":[10,20]}},
            {"type":"Feature","id":1,"properties":{"__transform_index":1},"geometry":{"type":"Point","coordinates":[30,40]}}
        ]});

        let mut changed_id = transformed.clone();
        changed_id["features"][0]["id"] = json!(99);
        assert!(merge_transformed_geometries(&source, &changed_id)
            .unwrap_err()
            .contains("索引 ID"));

        let mut changed_order = transformed.clone();
        changed_order["features"].as_array_mut().unwrap().swap(0, 1);
        assert!(merge_transformed_geometries(&source, &changed_order)
            .unwrap_err()
            .contains("索引 ID"));

        let mut changed_marker = transformed;
        changed_marker["features"][1]["properties"]["__transform_index"] = json!(0);
        assert!(merge_transformed_geometries(&source, &changed_marker)
            .unwrap_err()
            .contains("顺序标记"));
    }

    #[test]
    fn postgis_filter_expression_rewrites_only_known_fields_and_functions() {
        let fields = ["道路 名称", "路线\"ID", "status"];
        let parser = FilterExpressionParser::new(
            "lower(\"道路 名称\") ILIKE '国%' AND \"路线\"\"ID\" IN (1, 2) OR status IS NULL",
            &fields,
        )
        .unwrap();
        let sql = parser.parse().unwrap();
        assert_eq!(sql, "(((lower(\"道路 名称\") ILIKE E'国%') AND (\"路线\"\"ID\" IN (1, 2))) OR (\"status\" IS NULL))");
        let escaped = FilterExpressionParser::new(r#"name = 'a\b''c'"#, &["name"])
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(escaped, r#"("name" = E'a\\b''c')"#);
    }

    #[test]
    fn sqlite_filter_translation_uses_safe_literals_unicode_substr_and_like() {
        let parser = FilterExpressionParser::new_with_dialect(
            "left(name, -2) = 'x\\y''z' AND right(name, 2) ILIKE '国%'",
            &["name"],
            FilterDialect::Sqlite,
        )
        .unwrap();
        let sql = parser.parse().unwrap();
        assert!(sql.contains("substr(\"name\", 1, length(\"name\") + (-2))"));
        assert!(sql.contains("substr(\"name\", -(2))"));
        assert!(sql.contains("LIKE lower('国%')"));
        assert!(sql.contains("'x\\y''z'"));
        assert!(!sql.contains("E'"));
    }

    #[test]
    fn vector_query_options_validate_limit_offset_bbox_and_empty_filter() {
        assert_eq!(
            VectorQueryOptions::parse(&json!({})).unwrap().read_limit,
            500
        );
        assert_eq!(
            VectorQueryOptions::parse(&json!({"limit":10000,"offset":20,"bbox":[-10,-5,10,5]}))
                .unwrap()
                .offset,
            20
        );
        for query in [
            json!({"limit":10001}),
            json!({"offset":-1}),
            json!({"bbox":[0,0,0,1]}),
            json!({"expression":12}),
        ] {
            assert!(VectorQueryOptions::parse(&query).is_err());
        }
        assert!(!VectorQueryOptions::parse(&json!({"expression":"  "}))
            .unwrap()
            .has_source_filters());
    }

    #[test]
    fn vector_source_capability_contract_distinguishes_source_and_bounded_snapshot() {
        let file_capabilities =
            vector_capabilities("source", true, true, true, Some("SQLite"), true);
        let bounded_capabilities =
            vector_capabilities("snapshot", false, false, false, None, false);
        assert_eq!(file_capabilities["query_scope"], "source");
        assert_eq!(file_capabilities["attribute_filter"], true);
        assert_eq!(file_capabilities["native_dialect"], "SQLite");
        assert_eq!(bounded_capabilities["query_scope"], "snapshot");
        assert_eq!(bounded_capabilities["pagination"], false);
        assert_eq!(
            bounded_capabilities["native_dialect"],
            serde_json::Value::Null
        );
        let file = json!({"type":"file","path":"roads.gpkg"});
        let bounded = json!({"type":"connection","connection":{"kind":"wfs"}});
        assert_eq!(file["type"], "file");
        assert_eq!(bounded["connection"]["kind"], "wfs");
        let options = VectorQueryOptions::parse(&json!({"expression":"name = 'A'"})).unwrap();
        assert!(options.has_source_filters());
        assert_eq!(options.read_limit, 500);
    }

    #[test]
    fn sqlite_bbox_is_a_source_crs_sql_predicate_and_unknown_crs_is_rejected() {
        let predicate =
            sqlite_bbox_predicate("geom\"etry", [-123.0, 37.0, -122.0, 38.0], "EPSG:32610")
                .unwrap();
        assert_eq!(predicate, "ST_Intersects(\"geom\"\"etry\", ST_Transform(BuildMbr(-123.000000000000000,37.000000000000000,-122.000000000000000,38.000000000000000,4326), 32610))");
        assert!(sqlite_bbox_predicate("geom", [0.0, 0.0, 1.0, 1.0], "LOCAL_CS[custom]").is_err());
    }

    #[test]
    fn temporary_fid_property_avoids_business_field_collisions() {
        let fields = [
            json!({"name":"__road_query_fid"}),
            json!({"name":"__road_query_fid_"}),
        ];
        assert_eq!(
            collision_safe_field(&fields, "__road_query_fid"),
            "__road_query_fid__"
        );
    }

    #[test]
    fn postgis_filter_rejects_sql_injection_unknown_fields_and_unsupported_tokens() {
        let fields = ["name"];
        for expression in [
            "name = 'x'; DROP TABLE roads",
            "name = 'x' -- comment",
            "name IN (SELECT name FROM roads)",
            "other = 1",
            "roads.name = 'x'",
            "random(name) = 'x'",
            "name = 'x' UNION SELECT 1",
        ] {
            let error = FilterExpressionParser::new(expression, &fields)
                .and_then(|parser| parser.parse())
                .expect_err("表达式应被拒绝");
            assert!(!error.is_empty(), "表达式应被拒绝：{expression}");
        }
    }

    #[test]
    fn postgis_page_sql_validates_bbox_and_applies_filter_bbox_order_and_batch_limit() {
        let layer = json!({
            "extension_schema":"postgis",
            "fields":[{"name":"道路名称"},{"name":"active"}],
            "geometryFields":[{"name":"shape","is_geography":false}]
        });
        let options = RemoteReadOptions::parse(
            &json!({
                "filter_expression":"active = TRUE AND \"道路名称\" ILIKE '国%'",
                "bbox":[120.0,30.0,121.0,31.0],
                "offset":500,
                "read_limit":250
            }),
            DEFAULT_REMOTE_READ_LIMIT,
        )
        .unwrap();
        let sql = build_postgis_page_sql(
            &layer,
            ("路网", "道路.中心线"),
            "shape",
            Some("__srid"),
            &options,
            4547,
            Some(&["道路名称".into()]),
        )
        .unwrap();
        assert!(sql.contains("WHERE ((\"active\" = TRUE) AND (\"道路名称\" ILIKE E'国%')) AND \"shape\" && \"postgis\".ST_Transform(\"postgis\".ST_MakeEnvelope(120.000000000000000,30.000000000000000,121.000000000000000,31.000000000000000,4326),4547)"), "{sql}");
        assert!(sql.ends_with("ORDER BY \"道路名称\" LIMIT 251 OFFSET 500"));
        assert!(sql.contains("\"路网\".\"道路.中心线\""));
        assert!(RemoteReadOptions::parse(
            &json!({"bbox":[121,30,120,31]}),
            DEFAULT_REMOTE_READ_LIMIT
        )
        .is_err());
        assert!(
            RemoteReadOptions::parse(&json!({"read_limit":10001}), DEFAULT_REMOTE_READ_LIMIT)
                .is_err()
        );
    }

    #[test]
    fn postgis_page_sql_qualifies_geography_type() {
        let layer = json!({
            "extension_schema":"spatial ext",
            "fields":[],
            "geometryFields":[{"name":"geog","is_geography":true}]
        });
        let options =
            RemoteReadOptions::parse(&json!({"bbox":[-1,-1,1,1]}), DEFAULT_REMOTE_READ_LIMIT)
                .unwrap();
        let sql = build_postgis_page_sql(
            &layer,
            ("public", "roads"),
            "geog",
            None,
            &options,
            4326,
            None,
        )
        .unwrap();
        assert!(sql.contains("::\"spatial ext\".geography"));
        assert!(sql.ends_with("LIMIT 501 OFFSET 0"));
    }

    #[test]
    fn remote_read_limit_uses_source_specific_defaults() {
        let postgis = RemoteReadOptions::parse(&json!({}), DEFAULT_REMOTE_READ_LIMIT).unwrap();
        let other = RemoteReadOptions::parse(&json!({}), super::MAX_VECTOR_FEATURES).unwrap();
        assert_eq!(postgis.read_limit, 500);
        assert_eq!(other.read_limit, 2_000);
    }

    #[test]
    fn postgis_filter_limits_recursive_nesting_depth() {
        let fields = ["name"];
        let nested = format!("{}name = 'x'{}", "(".repeat(65), ")".repeat(65));
        let error = FilterExpressionParser::new(&nested, &fields)
            .unwrap()
            .parse()
            .unwrap_err();
        assert!(error.contains("64 层"));
        let nested_not = format!("{}name = 'x'", "NOT ".repeat(65));
        let error = FilterExpressionParser::new(&nested_not, &fields)
            .unwrap()
            .parse()
            .unwrap_err();
        assert!(error.contains("64 层"));
        let complex = format!("{}name = 1", "name = 1 OR ".repeat(1_024));
        assert!(FilterExpressionParser::new(&complex, &fields)
            .err()
            .is_some_and(|error| error.contains("复杂度")));
    }

    #[test]
    fn existing_empty_schema_and_oracle_uppercase_alias_are_not_connection_failures() {
        let info =
            json!({"layers":[{"features":[{"properties":{"SCHEMA_EXISTS":1,"SCHEMA_ACCESS":0}}]}]});
        let result = schema_probe_result(&info, "oracle").unwrap();
        assert!(result["message"].as_str().unwrap().contains("连接成功"));
        assert_eq!(result["schema_tables_confirmed"], false);
    }

    #[test]
    fn plain_postgres_success_and_schema_diagnostics_are_separate() {
        let info = json!({"layers":[{"features":[{"properties":{"connection_ok":1,"has_postgis":false,"schema_exists":true,"schema_access":true}}]}]});
        assert!(connection_probe_result(&info, true).unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("连接成功"));
        let mut missing = info.clone();
        missing["layers"][0]["features"][0]["properties"]["schema_exists"] = json!(false);
        assert!(connection_probe_result(&missing, true)
            .unwrap_err()
            .contains("不存在"));
        missing["layers"][0]["features"][0]["properties"]["schema_exists"] = json!(true);
        missing["layers"][0]["features"][0]["properties"]["schema_access"] = json!(false);
        assert!(connection_probe_result(&missing, true)
            .unwrap_err()
            .contains("USAGE"));
        assert!(connection_probe_sql(Some("a'b")).contains("a''b"));
    }

    #[test]
    fn connection_errors_are_actionable_and_never_echo_secrets() {
        for (error, expected) in [
            (
                "password authentication failed password='private'",
                "认证失败",
            ),
            ("no pg_hba.conf entry password='private'", "pg_hba.conf"),
            (
                "database x does not exist password='private'",
                "数据库不存在",
            ),
            ("Connection refused password='private'", "拒绝连接"),
            ("SSL error password='private'", "SSL"),
            ("timeout password='private'", "超时"),
        ] {
            let message = connection_failure_message(error);
            assert!(message.contains(expected));
            assert!(!message.contains("private"));
        }
        for (kind, error, expected) in [
            ("mysql", "Access denied for user secret", "MySQL 认证失败"),
            ("mysql", "MySQL connect failed: password=XXXXX denied for user 'reader' (using password: YES)", "MySQL 认证失败"),
            (
                "mssql",
                "Login failed for user secret",
                "SQL Server 登录失败",
            ),
            (
                "oracle",
                "ORA-01017: invalid username/password",
                "Oracle 认证失败",
            ),
        ] {
            let message = connection_failure_message_for(kind, error);
            assert!(message.contains(expected));
            assert!(!message.contains("secret"));
        }
    }

    #[test]
    fn connection_test_accepts_database_and_service_without_layer() {
        let pg = json!({"kind":"postgis","host":"localhost","database":"roads","user":"reader"});
        assert!(RemoteSourcePlan::parse_connection(&pg, false).is_ok());
        assert!(RemoteSourcePlan::parse(&pg).is_err());
        let wfs = json!({"kind":"wfs","url":"https://example.test/wfs"});
        assert!(RemoteSourcePlan::parse_connection(&wfs, false).is_ok());
        assert!(RemoteSourcePlan::parse(&wfs).is_err());
    }

    #[test]
    fn database_plans_use_documented_gdal_dialects_and_support_database_scope() {
        let mysql = RemoteSourcePlan::parse_connection(&json!({
            "kind":"mysql", "host":"db.example.test", "database":"roads", "user":"reader", "password":"secret"
        }), false).unwrap();
        assert!(mysql
            .source
            .starts_with("MYSQL:\"roads\",host=\"db.example.test\",port=3306,user=\"reader\",password=\"secret\""));
        assert_eq!(mysql.kind, "mysql");
        assert!(mysql
            .probe_source
            .as_deref()
            .unwrap()
            .contains("information_schema"));
        assert!(mysql.probe_sql.as_deref().unwrap().contains("SCHEMATA"));

        let mssql = RemoteSourcePlan::parse_connection(&json!({
            "kind":"mssql", "host":"db.example.test", "database":"roads", "auth":"windows", "encrypt":"yes", "trust_certificate":"no"
        }), false).unwrap();
        assert_eq!(mssql.source, "MSSQL:DRIVER={ODBC Driver 18 for SQL Server};SERVER={db.example.test,1433};DATABASE={roads};Encrypt=yes;TrustServerCertificate=no;Trusted_Connection=yes");

        let oracle = RemoteSourcePlan::parse_connection(&json!({
            "kind":"oracle", "host":"db.example.test", "service":"roads", "user":"reader", "password":"secret"
        }), false).unwrap();
        assert_eq!(
            oracle.source,
            "OCI:reader/secret@db.example.test:1521/roads"
        );
        assert_eq!(mysql_quote("p,ass\\word\"x"), "\"p,ass\\\\word\\\"x\"");
        assert_eq!(odbc_value("p;ass}word"), "{p;ass}}word}");
        assert!(schema_probe_sql("mssql", "roads")
            .unwrap()
            .contains("HAS_PERMS_BY_NAME"));
        assert!(schema_probe_sql("oracle", "roads")
            .unwrap()
            .contains("ALL_USERS"));
        let mssql_layer = RemoteSourcePlan::parse_connection(&json!({
            "kind":"mssql", "host":"db", "port":1433, "database":"roads", "schema":"dbo", "table":"centerline", "geometry_column":"shape", "auth":"sql", "user":"reader", "password":"semi;brace}quote\""
        }), true).unwrap();
        assert!(mssql_layer.source.contains("Tables=dbo.centerline(shape)"));
        assert!(mssql_layer.source.contains("PWD={semi;brace}}quote\"}"));
        assert_eq!(mssql_layer.layer_name, "dbo.centerline");
        assert!(mysql_probe_result(
            &json!({"layers":[{"features":[{"properties":{"database_visible":1}}]}]})
        )
        .is_ok());
        assert!(mysql_probe_result(&json!({"layers":[{"features":[]}]}))
            .unwrap_err()
            .contains("不存在"));

        let sqlite = RemoteSourcePlan::parse_connection(
            &json!({
                "kind":"gpkg", "path":"C:/data/roads.gpkg"
            }),
            false,
        );
        assert!(sqlite.is_err(), "连接计划必须验证本地文件实际存在");
    }

    #[test]
    fn connection_string_delimiter_injection_is_rejected_and_credentials_are_not_labels() {
        for connection in [
            json!({"kind":"mssql","host":"db,UID=evil","database":"roads","auth":"windows"}),
            json!({"kind":"oracle","host":"db","service":"roads","user":"reader","password":"secret@evil"}),
        ] {
            let error = RemoteSourcePlan::parse_connection(&connection, false)
                .err()
                .expect("连接分隔符注入应被拒绝");
            assert!(!error.contains("evil") && !error.contains("secret"));
        }
        let plan = RemoteSourcePlan::parse_connection(&json!({
            "kind":"mysql","host":"db","database":"roads","user":"reader","password":"secret","table":"centerline"
        }), true).unwrap();
        assert_eq!(plan.label, "roads.centerline");
        assert!(!plan.label.contains("secret"));
        let complex = RemoteSourcePlan::parse_connection(&json!({
            "kind":"mysql","host":"db","database":"roads,archive","user":"reader","password":"comma,quote\"and\\slash","table":"centerline"
        }), true).unwrap();
        assert!(complex.source.contains("\"roads,archive\""));
        assert!(complex.source.contains("\"comma,quote\\\"and\\\\slash\""));
        let mssql = RemoteSourcePlan::parse_connection(&json!({
            "kind":"mssql","host":"db","database":"roads","user":"reader","password":"semi;brace}quote\""
        }), false).unwrap();
        assert!(mssql.source.contains("PWD={semi;brace}}quote\"}"));
    }

    #[test]
    fn database_capability_report_uses_driver_short_names_and_explains_missing_drivers() {
        let result = database_capabilities("Supported Formats:\n PostgreSQL -vector- (rw): PostgreSQL/PostGIS\n MySQL -vector- (rw): MySQL\n GPKG -vector- (rw): GeoPackage");
        assert_eq!(result["databases"][0]["available"], true);
        assert_eq!(result["databases"][1]["available"], true);
        assert_eq!(result["databases"][2]["available"], false);
        assert!(result["databases"][2]["reason"]
            .as_str()
            .unwrap()
            .contains("MSSQLSpatial"));
        assert_eq!(result["databases"][5]["available"], true);
    }

    #[test]
    fn remote_catalog_returns_spatial_layers_and_limits_schema_scope() {
        let layers = vec![
            json!({"name":"transport.centerline","geometryFields":[{"name":"shape","type":"LineString"},{"name":"footprint","type":"Polygon"}]}),
            json!({"name":"public.parcels","geometryFields":[{"name":"geom","typeName":"MultiPolygon"}]}),
            json!({"name":"transport.metadata","fields":[{"name":"name"}]}),
        ];
        let all = remote_layer_summaries(&layers, "postgis", None);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0]["schema"], "transport");
        assert_eq!(all[0]["table"], "centerline");
        assert_eq!(all[0]["geometry_column"], "shape");
        assert_eq!(all[0]["geometry_type"], "LineString");
        assert_eq!(all[0]["type_name"], "");
        assert_eq!(all[1]["geometry_column"], "footprint");
        assert_eq!(all[1]["type_name"], "");

        let scoped = remote_layer_summaries(&layers, "postgis", Some("transport"));
        assert_eq!(scoped.len(), 2);
        assert_eq!(scoped[0]["table"], "centerline");
        assert_eq!(scoped[0]["geometry_column"].as_str(), Some("shape"));
        assert_eq!(scoped[0]["type_name"].as_str(), Some(""));
    }

    #[test]
    fn schema_scope_accepts_saved_default_schema() {
        let connection = json!({
            "kind":"mssql",
            "scope":"schema",
            "schema":"",
            "default_schema":"roads",
        });
        assert_eq!(
            connection_schema(&connection, "mssql").unwrap(),
            Some("roads")
        );
        assert!(connection_schema(&json!({"kind":"mssql","scope":"schema"}), "mssql").is_err());
    }

    #[test]
    fn remote_wfs_catalog_keeps_type_names_and_empty_database_type_names() {
        let layers = vec![json!({
            "name":"roads:centerline",
            "geometryFields":[{"name":"geom","type":"LineString"}]
        })];
        let wfs = remote_layer_summaries(&layers, "wfs", None);
        assert_eq!(wfs[0]["schema"], "");
        assert_eq!(wfs[0]["table"], "roads:centerline");
        assert_eq!(wfs[0]["type_name"], "roads:centerline");
        assert_eq!(wfs[0]["geometry_column"], "geom");
    }

    #[test]
    fn postgis_import_sql_selects_one_geometry_and_preserves_attributes() {
        let layer = json!({
            "geometryFields":[
                {"name":"geom","coordinateSystem":{"id":{"authority":"EPSG","code":4326}}},
                {"name":"alternate","coordinateSystem":{"id":{"authority":"EPSG","code":3857}}}
            ],
            "fields":[
                {"name":"id"},
                {"name":"geom"},
                {"name":"road\"name"},
                {"name":"alternate"}
            ]
        });
        let sql =
            build_postgis_import_sql(&layer, "de\"sign", "road.table", "alternate", None).unwrap();
        assert_eq!(
            sql,
            "SELECT \"alternate\", \"id\", \"road\"\"name\" FROM \"de\"\"sign\".\"road.table\""
        );
        assert!(!sql.contains("\"geom\""));
        assert_eq!(
            find_geometry_crs(&layer, "alternate"),
            Some("EPSG:3857".into())
        );
        assert!(
            build_postgis_import_sql(&layer, "design", "roads", "missing", None)
                .unwrap_err()
                .contains("几何列")
        );
    }

    #[test]
    fn postgis_batch_validation_rejects_mixed_srid_without_overwriting_business_fields() {
        let layer = json!({"extension_schema":"public", "geometryFields":[{"name":"geom"}], "fields":[{"name":"__road_import_srid"},{"name":"route_id"}]});
        let field = postgis_validation_field(&layer);
        assert_eq!(field, "__road_import_srid_");
        let sql =
            build_postgis_import_sql(&layer, "design", "roads", "geom", Some(&field)).unwrap();
        assert!(sql.contains("\"public\".ST_SRID(\"geom\") AS \"__road_import_srid_\""));
        let mut valid = vec![
            json!({"geometry":{"type":"LineString"}, "properties":{"route_id":"R1", "__road_import_srid":"business-value", "__road_import_srid_":32650}}),
        ];
        validate_postgis_batch_srid(&mut valid, &field, 32650).unwrap();
        assert_eq!(
            valid[0]["properties"]["__road_import_srid"],
            "business-value"
        );
        assert!(valid[0]["properties"].get(&field).is_none());
        let mut mixed = vec![
            json!({"geometry":{"type":"LineString"}, "properties":{"__road_import_srid_":4326}}),
        ];
        assert!(validate_postgis_batch_srid(&mut mixed, &field, 32650)
            .unwrap_err()
            .contains("SRID"));
        let mut missing = vec![json!({"geometry":{"type":"LineString"}, "properties":{}})];
        assert!(validate_postgis_batch_srid(&mut missing, &field, 32650).is_err());
        let mut null_geometry =
            vec![json!({"geometry":null, "properties":{"__road_import_srid_":null}})];
        validate_postgis_batch_srid(&mut null_geometry, &field, 32650).unwrap();
    }

    #[test]
    fn postgis_crs_keeps_custom_authority_and_falls_back_to_wkt() {
        assert_eq!(
            postgis_crs_identifier(&json!({
                "auth_name":"CUSTOM_TEST",
                "auth_srid":990050,
                "srtext":"LOCAL CRS WKT"
            })),
            Some("CUSTOM_TEST:990050".into())
        );
        assert_eq!(
            postgis_crs_identifier(&json!({
                "auth_name":"",
                "auth_srid":0,
                "srtext":"LOCAL CRS WKT"
            })),
            Some("LOCAL CRS WKT".into())
        );
        assert_eq!(
            postgis_crs_identifier(&json!({
                "auth_name":"",
                "auth_srid":0,
                "srtext":""
            })),
            None
        );
        assert_eq!(
            postgis_sample_srid_sql("post\"gis", "design.2026", "roads.main", "alternate"),
            "SELECT \"post\"\"gis\".ST_SRID(\"alternate\") AS srid FROM \"design.2026\".\"roads.main\" WHERE \"alternate\" IS NOT NULL LIMIT 1"
        );
    }

    #[test]
    fn wfs_plan_targets_named_layer_and_bounds_page_size() {
        let plan = RemoteSourcePlan::parse(&json!({
            "kind": "wfs",
            "url": "https://maps.example.test/geoserver/wfs?token=do-not-return",
            "type_name": "roads:centerline",
            "version": "2.0.0",
            "page_size": 1000
        }))
        .unwrap();

        assert_eq!(plan.layer_name, "roads:centerline");
        assert_eq!(plan.kind, "wfs");
        assert_eq!(plan.page_size, 500);
        assert!(plan.source.starts_with("WFS:https://"));
        assert!(plan.source.contains("version=2.0.0"));
    }

    #[test]
    fn rejects_invalid_wfs_url_and_version_without_echoing_input() {
        let secret = "token=private-value";
        let invalid_url = RemoteSourcePlan::parse(&json!({
            "kind": "wfs",
            "url": format!("ftp://maps.example.test/wfs?{secret}"),
            "type_name": "roads:centerline"
        }))
        .err()
        .expect("WFS URL 应被拒绝");
        assert!(!invalid_url.contains(secret));

        let invalid_version = RemoteSourcePlan::parse(&json!({
            "kind": "wfs",
            "url": "https://maps.example.test/wfs",
            "type_name": "roads:centerline",
            "version": "2.0.0;secret"
        }))
        .err()
        .expect("WFS 版本应被拒绝");
        assert!(!invalid_version.contains("secret"));
    }

    #[test]
    fn postgis_plan_quotes_identifiers_adds_connect_timeout_and_hides_password_from_label() {
        let password = "p'a\\ss";
        let plan = RemoteSourcePlan::parse(&json!({
            "kind": "postgis",
            "host": "db.example.test",
            "port": 5432,
            "database": "roads",
            "schema": "road\"data",
            "table": "centerline",
            "geometry_column": "shape",
            "user": "reader",
            "password": password,
            "sslmode": "require"
        }))
        .unwrap();

        assert!(plan.source.contains("connect_timeout=20"));
        assert!(plan.source.contains("password='p\\'a\\\\ss'"));
        assert!(plan.sql.is_none());
        assert_eq!(plan.label, "road\"data.centerline");
        assert!(!plan.label.contains(password));
    }

    #[test]
    fn rejects_invalid_postgis_port_without_echoing_connection_secrets() {
        let result = RemoteSourcePlan::parse(&json!({
            "kind": "postgis",
            "host": "db.example.test",
            "port": 65536,
            "database": "roads",
            "schema": "public",
            "table": "centerline",
            "geometry_column": "geom",
            "user": "reader",
            "password": "private-password"
        }));

        let error = result.err().expect("无效端口应被拒绝");
        assert!(error.contains("端口"));
        assert!(!error.contains("private-password"));
    }

    #[test]
    fn http_url_requires_http_scheme_and_nonempty_authority() {
        assert!(valid_http_url("https://maps.example.test/wfs"));
        assert!(!valid_http_url("https:///wfs"));
        assert!(!valid_http_url("https://maps.example.test/wfs with-space"));
    }
}
