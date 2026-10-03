mod credentials;
mod engine;
mod gis;
mod project;

use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(engine::EngineState::default())
        .manage(gis::GisState::default())
        .invoke_handler(tauri::generate_handler![
            generate_road,
            cancel_generation,
            project::save_project,
            project::load_project,
            project::save_catalog,
            project::read_catalog,
            credentials::read_connection_password,
            credentials::store_connection_password,
            credentials::delete_connection_password,
            write_geojson,
            facilities_catalog,
            gis::import_vector,
            gis::list_vector_layers,
            gis::import_remote_vector,
            gis::list_remote_layers,
            gis::test_remote_connection,
            gis::get_database_capabilities,
            gis::import_raster,
            gis::export_geopackage,
            gis::raster_tile,
            gis::crs_definition,
            gis::validate_geometry,
        ])
        .setup(|app| {
            app.manage(Arc::new(engine::EnginePaths::new(app.handle())));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动道路几何桌面端失败");
}

#[tauri::command]
async fn generate_road(
    request: serde_json::Value,
    job_id: String,
    state: tauri::State<'_, engine::EngineState>,
    paths: tauri::State<'_, Arc<engine::EnginePaths>>,
) -> Result<serde_json::Value, String> {
    let control = state.reserve(&job_id)?;
    let joined = tauri::async_runtime::spawn_blocking({
        let control = Arc::clone(&control);
        let paths = Arc::clone(paths.inner());
        move || engine::run_engine(&paths, request, control)
    })
    .await;
    state.release_if_current(&job_id, &control);
    joined.map_err(|error| format!("引擎任务线程失败：{error}"))?
}

#[tauri::command]
fn cancel_generation(job_id: String, state: tauri::State<'_, engine::EngineState>) -> bool {
    state.cancel(&job_id)
}

#[tauri::command]
async fn facilities_catalog(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || facilities_catalog_blocking(app))
        .await
        .map_err(|error| format!("设施目录读取线程失败：{error}"))?
}

fn facilities_catalog_blocking(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let resource_path = app
        .path()
        .resolve("catalog.json", tauri::path::BaseDirectory::Resource)
        .ok();
    let development_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("catalog.json");
    let catalog_path = resource_path
        .filter(|path| path.is_file())
        .or_else(|| development_path.is_file().then_some(development_path))
        .ok_or("设施目录资源 catalog.json 不存在")?;
    let bytes = std::fs::read(&catalog_path)
        .map_err(|error| format!("无法读取设施目录 {}：{error}", catalog_path.display()))?;
    let catalog: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("设施目录 JSON 无效：{error}"))?;
    project::validate_catalog(&catalog)?;
    Ok(catalog)
}

#[tauri::command]
async fn write_geojson(path: String, collection: serde_json::Value) -> Result<(), String> {
    project::write_geojson(path, collection).await
}
