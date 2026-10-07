mod generation_issues;

use road_geometry_service::{runtime::RuntimeContext, Service};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(generation_issues::GenerationIssuesState::default())
        .invoke_handler(tauri::generate_handler![
            generation_issues::open_generation_issues_window,
            generation_issues::sync_generation_issues_window,
            generation_issues::get_generation_issues_snapshot,
            generation_issues::submit_generation_issue_action,
            generation_issues::minimize_generation_issues_window,
            generation_issues::start_dragging_generation_issues_window,
            generation_issues::close_generation_issues_window,
            generate_road,
            generate_roads_batch,
            cancel_generation,
            save_project,
            load_project,
            save_catalog,
            read_catalog,
            read_connection_password,
            store_connection_password,
            delete_connection_password,
            write_geojson,
            facilities_catalog,
            import_vector,
            query_vector_data,
            list_vector_layers,
            import_remote_vector,
            list_remote_layers,
            test_remote_connection,
            get_database_capabilities,
            import_raster,
            export_geopackage,
            raster_tile,
            crs_definition,
            validate_geometry,
            transform_collection
        ])
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            app.manage(Arc::new(Service::new(RuntimeContext::new(resource_dir))));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动道路几何桌面端失败");
}

async fn dispatch(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
    command: &'static str,
    args: Value,
) -> Result<Value, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let app_for_progress = app.clone();
        let progress = Arc::new(move |payload: Value| {
            let _ = app_for_progress.emit("road-batch-progress", payload.clone());
            let _ = app_for_progress.emit("generation-progress", payload);
        });
        service.dispatch(command, args, progress)
    })
    .await
    .map_err(|error| format!("桌面服务工作线程失败：{error}"))?
}

#[tauri::command]
async fn generate_road(
    request: Value,
    job_id: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "generate_road",
        json!({"request":request,"job_id":job_id}),
    )
    .await
}
#[tauri::command]
async fn generate_roads_batch(
    tasks: Value,
    job_id: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "generate_roads_batch",
        json!({"tasks":tasks,"job_id":job_id}),
    )
    .await
}
#[tauri::command]
async fn cancel_generation(
    job_id: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(app, service, "cancel_generation", json!({"job_id":job_id})).await
}
#[tauri::command]
async fn save_project(
    path: String,
    project: Value,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "save_project",
        json!({"path":path,"project":project}),
    )
    .await
}
#[tauri::command]
async fn load_project(
    path: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(app, service, "load_project", json!({"path":path})).await
}
#[tauri::command]
async fn save_catalog(
    path: String,
    catalog: Value,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "save_catalog",
        json!({"path":path,"catalog":catalog}),
    )
    .await
}
#[tauri::command]
async fn read_catalog(
    path: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(app, service, "read_catalog", json!({"path":path})).await
}
#[tauri::command]
async fn read_connection_password(
    connection_id: String,
    identity: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "read_connection_password",
        json!({"connection_id":connection_id,"identity":identity}),
    )
    .await
}
#[tauri::command]
async fn store_connection_password(
    connection_id: String,
    identity: String,
    password: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "store_connection_password",
        json!({"connection_id":connection_id,"identity":identity,"password":password}),
    )
    .await
}
#[tauri::command]
async fn delete_connection_password(
    connection_id: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "delete_connection_password",
        json!({"connection_id":connection_id}),
    )
    .await
}
#[tauri::command]
async fn write_geojson(
    path: String,
    collection: Value,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "write_geojson",
        json!({"path":path,"collection":collection}),
    )
    .await
}
#[tauri::command]
async fn facilities_catalog(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(app, service, "facilities_catalog", json!({})).await
}
#[tauri::command]
async fn import_vector(
    path: String,
    layer_name: Option<String>,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "import_vector",
        json!({"path":path,"layer_name":layer_name}),
    )
    .await
}
#[tauri::command]
async fn query_vector_data(
    source: Value,
    query: Value,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "query_vector_data",
        json!({"source":source,"query":query}),
    )
    .await
}
#[tauri::command]
async fn list_vector_layers(
    path: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(app, service, "list_vector_layers", json!({"path":path})).await
}
#[tauri::command]
async fn import_remote_vector(
    connection: Value,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "import_remote_vector",
        json!({"connection":connection}),
    )
    .await
}
#[tauri::command]
async fn list_remote_layers(
    connection: Value,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "list_remote_layers",
        json!({"connection":connection}),
    )
    .await
}
#[tauri::command]
async fn test_remote_connection(
    connection: Value,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "test_remote_connection",
        json!({"connection":connection}),
    )
    .await
}
#[tauri::command]
async fn get_database_capabilities(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(app, service, "get_database_capabilities", json!({})).await
}
#[tauri::command]
async fn import_raster(
    path: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(app, service, "import_raster", json!({"path":path})).await
}
#[tauri::command]
async fn export_geopackage(
    path: String,
    layers: Value,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "export_geopackage",
        json!({"path":path,"layers":layers}),
    )
    .await
}
#[tauri::command]
async fn crs_definition(
    crs: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<String, String> {
    dispatch(app, service, "crs_definition", json!({"crs":crs}))
        .await?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "坐标系查询返回值无效".into())
}
#[tauri::command]
async fn validate_geometry(
    collection: Value,
    crs: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "validate_geometry",
        json!({"collection":collection,"crs":crs}),
    )
    .await
}

#[tauri::command]
async fn transform_collection(
    collection: Value,
    source_crs: String,
    target_crs: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    dispatch(
        app,
        service,
        "transform_collection",
        json!({
            "collection": collection,
            "source_crs": source_crs,
            "target_crs": target_crs
        }),
    )
    .await
}

#[tauri::command]
async fn raster_tile(
    id: String,
    z: u32,
    x: u32,
    y: u32,
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<tauri::ipc::Response, String> {
    let result = dispatch(
        app,
        service,
        "raster_tile",
        json!({"id":id,"z":z,"x":x,"y":y}),
    )
    .await?;
    let encoded = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or("栅格瓦片响应缺少 data")?;
    let bytes = decode_base64(encoded)?;
    Ok(tauri::ipc::Response::new(bytes))
}
fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for b in text.bytes() {
        if b == b'=' {
            break;
        }
        let value = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("栅格瓦片 base64 无效".into()),
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8)
        }
    }
    Ok(out)
}
