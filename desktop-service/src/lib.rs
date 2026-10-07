mod batch;
mod credentials;
mod engine;
mod gis;
mod project;
pub mod runtime;
pub use engine::EnginePaths;

use runtime::RuntimeContext;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 命令无关的共享桌面业务服务。耗时命令由调用方放入阻塞线程池。
pub struct Service {
    context: RuntimeContext,
    engine_state: engine::EngineState,
    gis_state: gis::GisState,
    runtime: tokio::runtime::Runtime,
    write_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl Service {
    pub fn new(context: RuntimeContext) -> Self {
        Self {
            context,
            engine_state: Default::default(),
            gis_state: Default::default(),
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("桌面服务 Tokio runtime 创建失败"),
            write_locks: Mutex::new(HashMap::new()),
        }
    }

    /// 取消所有正在运行的道路生成任务，并拒绝新的道路生成任务。GIS 工具进程运行期间不支持协作取消；服务会等待其返回后再退出。
    pub fn shutdown(&self) {
        self.engine_state.cancel_all();
    }

    fn path_lock(&self, path: &str) -> Result<Arc<Mutex<()>>, String> {
        let destination = Path::new(path);
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = dunce::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        let key = parent.join(destination.file_name().ok_or("目标路径缺少文件名")?);
        let mut locks = self
            .write_locks
            .lock()
            .map_err(|_| "项目写入锁不可用".to_string())?;
        Ok(Arc::clone(
            locks.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
    }

    /// 执行一个原生命令。单任务在预留 job_id 后先发送 completed=0 的进度事件，可据此安全提交取消请求。
    pub fn dispatch(
        &self,
        command: &str,
        args: Value,
        progress: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Value, String> {
        let command = command.replace('-', "_");
        match command.as_str() {
            "generate_road" | "generateRoad" => {
                let request = args
                    .get("request")
                    .or_else(|| args.get("request"))
                    .cloned()
                    .ok_or("缺少参数 request")?;
                let id = args
                    .get("job_id")
                    .or_else(|| args.get("jobId"))
                    .and_then(Value::as_str)
                    .unwrap_or("service-job");
                let control = self.engine_state.reserve(id)?;
                progress(json!({"job_id":id,"total":1,"completed":0,"succeeded":0,"failed":0}));
                let paths = engine::EnginePaths::new(&self.context);
                let result = engine::run_engine(&paths, request, control.clone());
                self.engine_state.release_if_current(id, &control);
                progress(
                    json!({"job_id":id,"total":1,"completed":1,"succeeded":u8::from(result.is_ok()),"failed":u8::from(result.is_err())}),
                );
                result
            }
            "cancel_generation" | "cancelGeneration" => Ok(json!(self.engine_state.cancel(
                args.get("job_id")
                    .or_else(|| args.get("jobId"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ))),
            "generate_roads_batch" | "generateRoadsBatch" => {
                let tasks = args.get("tasks").cloned().ok_or("缺少参数 tasks")?;
                let id = args
                    .get("job_id")
                    .or_else(|| args.get("jobId"))
                    .and_then(Value::as_str)
                    .unwrap_or("service-batch")
                    .to_string();
                let control = self.engine_state.reserve(&id)?;
                let paths = Arc::new(engine::EnginePaths::new(&self.context));
                let result = batch::run_batch(tasks, id.clone(), paths, control.clone(), progress);
                self.engine_state.release_if_current(&id, &control);
                result
            }
            "save_project" | "saveProject" => {
                let path = arg_str(&args, "path", "path")?;
                let project = args.get("project").cloned().ok_or("缺少参数 project")?;
                let write_lock = self.path_lock(&path)?;
                let _guard = write_lock
                    .lock()
                    .map_err(|_| "项目写入锁不可用".to_string())?;
                self.runtime
                    .block_on(project::save_project(path, project))?;
                Ok(Value::Null)
            }
            "load_project" | "loadProject" => {
                let path = arg_str(&args, "path", "path")?;
                self.runtime.block_on(project::load_project(path))
            }
            "save_catalog" | "saveCatalog" => {
                let path = arg_str(&args, "path", "path")?;
                let catalog = args.get("catalog").cloned().ok_or("缺少参数 catalog")?;
                let write_lock = self.path_lock(&path)?;
                let _guard = write_lock
                    .lock()
                    .map_err(|_| "项目写入锁不可用".to_string())?;
                self.runtime
                    .block_on(project::save_catalog(path, catalog))?;
                Ok(Value::Null)
            }
            "read_catalog" | "readCatalog" => {
                let path = arg_str(&args, "path", "path")?;
                self.runtime.block_on(project::read_catalog(path))
            }
            "write_geojson" | "writeGeojson" => {
                let path = arg_str(&args, "path", "path")?;
                let collection = args
                    .get("collection")
                    .cloned()
                    .ok_or("缺少参数 collection")?;
                let write_lock = self.path_lock(&path)?;
                let _guard = write_lock
                    .lock()
                    .map_err(|_| "项目写入锁不可用".to_string())?;
                self.runtime
                    .block_on(project::write_geojson(path, collection))?;
                Ok(Value::Null)
            }
            "facilities_catalog" | "facilitiesCatalog" => {
                let path = self
                    .context
                    .catalog_candidates()
                    .into_iter()
                    .find(|p| p.is_file())
                    .ok_or("设施目录资源 catalog.json 不存在")?;
                self.runtime
                    .block_on(project::read_catalog(path.to_string_lossy().into_owned()))
            }
            "read_connection_password" | "readConnectionPassword" => {
                let id = arg_str(&args, "connection_id", "connectionId")?;
                let identity = arg_str(&args, "identity", "identity")?;
                self.runtime
                    .block_on(credentials::read_connection_password(id, identity))
                    .map(|v| json!(v))
            }
            "store_connection_password" | "storeConnectionPassword" => {
                let id = arg_str(&args, "connection_id", "connectionId")?;
                let identity = arg_str(&args, "identity", "identity")?;
                let password = arg_str(&args, "password", "password")?;
                self.runtime
                    .block_on(credentials::store_connection_password(
                        id, identity, password,
                    ))?;
                Ok(Value::Null)
            }
            "delete_connection_password" | "deleteConnectionPassword" => {
                let id = arg_str(&args, "connection_id", "connectionId")?;
                self.runtime
                    .block_on(credentials::delete_connection_password(id))?;
                Ok(Value::Null)
            }
            other => gis::dispatch(other, &args, &self.context, &self.gis_state),
        }
    }
}
fn arg_str(value: &Value, camel: &str, snake: &str) -> Result<String, String> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("缺少参数 {camel}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equivalent_project_paths_share_one_write_lock() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project.json");
        let alternate = directory
            .path()
            .join("nested")
            .join("..")
            .join("project.json");
        std::fs::create_dir(directory.path().join("nested")).unwrap();
        let service = Service::new(RuntimeContext::new(None));
        let first = service.path_lock(path.to_str().unwrap()).unwrap();
        let second = service.path_lock(alternate.to_str().unwrap()).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn explicit_resource_dir_does_not_fall_back_to_tauri_assets() {
        let context = RuntimeContext::new(Some(PathBuf::from("C:/standalone")));
        assert_eq!(
            context.gis_candidates(),
            vec![PathBuf::from("C:/standalone/gis")]
        );
        assert_eq!(
            context.catalog_candidates(),
            vec![PathBuf::from("C:/standalone/catalog.json")]
        );
    }
}
