use crate::engine::{EnginePaths, EngineSession, JobControl};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

const MAX_TASKS_PER_CHUNK: usize = 512;
const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
const MAX_WORKERS: usize = 4;

#[derive(Debug, Deserialize)]
struct BatchTask {
    key: String,
    dataset_id: String,
    feature_key: String,
    part_index: usize,
    request: Value,
}

#[derive(Debug, Serialize)]
struct BatchResult {
    key: String,
    dataset_id: String,
    feature_key: String,
    part_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

enum WorkerMessage {
    Completed(usize, Result<Value, String>),
    Finished,
}

pub(crate) fn run_batch(
    tasks_value: Value,
    job_id: String,
    paths: Arc<EnginePaths>,
    control: Arc<JobControl>,
    progress: Arc<dyn Fn(Value) + Send + Sync>,
) -> Result<Value, String> {
    let input_bytes =
        serde_json::to_vec(&tasks_value).map_err(|error| format!("批量任务 JSON 无效：{error}"))?;
    if input_bytes.len() > MAX_INPUT_BYTES {
        return Err(format!("批量任务输入超过 {MAX_INPUT_BYTES} 字节上限"));
    }
    let raw_tasks = tasks_value
        .as_array()
        .ok_or_else(|| "批量任务必须是数组".to_string())?;
    if raw_tasks.is_empty() || raw_tasks.len() > MAX_TASKS_PER_CHUNK {
        return Err(format!(
            "单批次任务数量必须在 1..={MAX_TASKS_PER_CHUNK} 范围内；请由前端拆分更大的工程任务"
        ));
    }
    let tasks: Vec<BatchTask> = serde_json::from_value(tasks_value)
        .map_err(|error| format!("批量任务字段无效：{error}"))?;
    run_tasks(tasks, job_id, paths, control, progress)
}

fn run_tasks(
    tasks: Vec<BatchTask>,
    job_id: String,
    paths: Arc<EnginePaths>,
    control: Arc<JobControl>,
    progress: Arc<dyn Fn(Value) + Send + Sync>,
) -> Result<Value, String> {
    let total = tasks.len();
    let worker_count = worker_count();
    let started_at = Instant::now();
    let engine_processes_started = Arc::new(AtomicUsize::new(0));
    let engine_process_ids = Arc::new(Mutex::new(Vec::<u32>::new()));
    let metadata: Vec<_> = tasks
        .iter()
        .map(|task| {
            (
                task.key.clone(),
                task.dataset_id.clone(),
                task.feature_key.clone(),
                task.part_index,
            )
        })
        .collect();
    let queue = Arc::new(Mutex::new(
        tasks.into_iter().enumerate().collect::<VecDeque<_>>(),
    ));
    let (sender, receiver) = mpsc::sync_channel::<WorkerMessage>(worker_count);
    let mut results: Vec<Option<BatchResult>> = (0..total).map(|_| None).collect();
    let mut completed = 0;
    let mut succeeded = 0;
    let mut failed = 0;
    let mut output_bytes = 0_usize;
    let mut fatal_error = None;
    let mut workers_finished = 0;
    let mut last_progress = Instant::now();

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let queue = Arc::clone(&queue);
            let sender = sender.clone();
            let paths = Arc::clone(&paths);
            let control = Arc::clone(&control);
            let started = Arc::clone(&engine_processes_started);
            let process_ids = Arc::clone(&engine_process_ids);
            scope.spawn(move || worker(queue, sender, paths, control, started, process_ids));
        }
        drop(sender);

        while workers_finished < worker_count {
            match receiver.recv() {
                Ok(WorkerMessage::Completed(index, outcome)) => {
                    completed += 1;
                    let (key, dataset_id, feature_key, part_index) = &metadata[index];
                    let batch_result = match outcome {
                        Ok(response) => {
                            succeeded += 1;
                            BatchResult {
                                key: key.clone(),
                                dataset_id: dataset_id.clone(),
                                feature_key: feature_key.clone(),
                                part_index: *part_index,
                                response: Some(response),
                                error: None,
                            }
                        }
                        Err(error) => {
                            failed += 1;
                            BatchResult {
                                key: key.clone(),
                                dataset_id: dataset_id.clone(),
                                feature_key: feature_key.clone(),
                                part_index: *part_index,
                                response: None,
                                error: Some(error),
                            }
                        }
                    };
                    match serde_json::to_vec(&batch_result) {
                        Ok(bytes) => {
                            match bounded_total(output_bytes, bytes.len(), MAX_OUTPUT_BYTES) {
                                Some(total_bytes) => {
                                    output_bytes = total_bytes;
                                    results[index] = Some(batch_result);
                                }
                                None => {
                                    fatal_error = Some(format!(
                                        "批量任务结果超过 {MAX_OUTPUT_BYTES} 字节上限"
                                    ));
                                    control.cancel();
                                }
                            }
                        }
                        Err(error) => {
                            fatal_error = Some(format!("批量结果无法序列化：{error}"));
                            control.cancel();
                        }
                    }
                    // 统计逐项累计，界面通知合并为约每 25ms 一次，避免碎段产生大量 IPC。
                    if completed == 1
                        || completed == total
                        || last_progress.elapsed().as_millis() >= 25
                    {
                        progress(json!({
                            "job_id": job_id.clone(),
                            "total": total,
                            "completed": completed,
                            "succeeded": succeeded,
                            "failed": failed,
                        }));
                        last_progress = Instant::now();
                    }
                }
                Ok(WorkerMessage::Finished) => workers_finished += 1,
                Err(_) => break,
            }
        }
    });

    if let Some(error) = fatal_error {
        return Err(error);
    }
    if control.is_canceled() {
        return Err("道路批量生成已取消".into());
    }
    let results = results
        .into_iter()
        .map(|result| result.ok_or_else(|| "批量任务未能完成".to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let response = json!({
        "results": results,
        "total": total,
        "completed": completed,
        "worker_count": worker_count,
        "elapsed_ms": started_at.elapsed().as_millis(),
        "engine_processes_started": engine_processes_started.load(Ordering::Relaxed),
        "engine_process_ids": engine_process_ids
            .lock()
            .map(|ids| ids.clone())
            .unwrap_or_default(),
    });
    let response_bytes =
        serde_json::to_vec(&response).map_err(|error| format!("批量结果无法序列化：{error}"))?;
    if bounded_total(0, response_bytes.len(), MAX_OUTPUT_BYTES).is_none() {
        return Err(format!("批量任务完整响应超过 {MAX_OUTPUT_BYTES} 字节上限"));
    }
    Ok(response)
}

fn worker(
    queue: Arc<Mutex<VecDeque<(usize, BatchTask)>>>,
    sender: SyncSender<WorkerMessage>,
    paths: Arc<EnginePaths>,
    control: Arc<JobControl>,
    engine_processes_started: Arc<AtomicUsize>,
    engine_process_ids: Arc<Mutex<Vec<u32>>>,
) {
    let mut session: Option<EngineSession> = None;
    loop {
        let next_task = take_next_task(&queue, &control);
        let Some((index, task)) = next_task else {
            break;
        };
        if session.as_ref().is_none_or(EngineSession::is_closed) {
            match EngineSession::start(&paths) {
                Ok(started) => {
                    engine_processes_started.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut ids) = engine_process_ids.lock() {
                        ids.push(started.process_id());
                    }
                    session = Some(started);
                }
                Err(error) => {
                    if sender
                        .send(WorkerMessage::Completed(index, Err(error)))
                        .is_err()
                    {
                        break;
                    }
                    continue;
                }
            }
        }
        let outcome = session
            .as_mut()
            .expect("流式会话已初始化")
            .execute(task.request, &control);
        if session.as_ref().is_some_and(EngineSession::is_closed) {
            session = None;
        }
        if sender
            .send(WorkerMessage::Completed(index, outcome))
            .is_err()
        {
            break;
        }
    }
    let _ = sender.send(WorkerMessage::Finished);
}

fn worker_count() -> usize {
    thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, MAX_WORKERS)
}

fn take_next_task(
    queue: &Mutex<VecDeque<(usize, BatchTask)>>,
    control: &JobControl,
) -> Option<(usize, BatchTask)> {
    if control.is_canceled() {
        return None;
    }
    queue.lock().ok().and_then(|mut queue| {
        if control.is_canceled() {
            None
        } else {
            queue.pop_front()
        }
    })
}

fn bounded_total(current: usize, addition: usize, limit: usize) -> Option<usize> {
    current
        .checked_add(addition)
        .filter(|total| *total <= limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine;

    #[test]
    fn rejects_invalid_batch_shape_and_limits() {
        assert!(validate_tasks(json!([])).is_err());
        assert!(validate_tasks(json!({})).is_err());
        assert!(validate_tasks(json!([{"key": "x"}])).is_err());
    }

    fn validate_tasks(value: Value) -> Result<Vec<BatchTask>, String> {
        let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_INPUT_BYTES {
            return Err("输入超限".into());
        }
        let items = value.as_array().ok_or_else(|| "必须为数组".to_string())?;
        if items.is_empty() || items.len() > MAX_TASKS_PER_CHUNK {
            return Err("数量超限".into());
        }
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    #[test]
    fn rejects_oversized_input_and_result_entries() {
        let oversized = json!([{
            "key": "x",
            "dataset_id": "d",
            "feature_key": "f",
            "part_index": 0,
            "request": {"payload": "x".repeat(MAX_INPUT_BYTES)}
        }]);
        assert!(validate_tasks(oversized).is_err());

        let result = BatchResult {
            key: "k".into(),
            dataset_id: "d".into(),
            feature_key: "f".into(),
            part_index: 0,
            response: Some(json!({"payload": "x".repeat(MAX_OUTPUT_BYTES)})),
            error: None,
        };
        assert!(serde_json::to_vec(&result).unwrap().len() > MAX_OUTPUT_BYTES);
    }

    #[test]
    fn cancellation_stops_dispatching_queued_tasks() {
        let state = engine::EngineState::default();
        let control = state.reserve("batch-cancel").unwrap();
        let queue = Mutex::new(VecDeque::from([(
            0,
            BatchTask {
                key: "k".into(),
                dataset_id: "d".into(),
                feature_key: "f".into(),
                part_index: 0,
                request: json!({}),
            },
        )]));
        control.cancel();
        assert!(take_next_task(&queue, &control).is_none());
        assert_eq!(queue.lock().unwrap().len(), 1);
        state.release_if_current("batch-cancel", &control);
    }

    #[test]
    fn aggregate_result_limit_accepts_boundary_and_rejects_overflow() {
        assert_eq!(bounded_total(8, 2, 10), Some(10));
        assert_eq!(bounded_total(8, 3, 10), None);
        assert_eq!(bounded_total(usize::MAX, 1, usize::MAX), None);
    }

    #[test]
    fn worker_pool_size_is_bounded_by_available_parallelism_and_four() {
        assert!((1..=MAX_WORKERS).contains(&worker_count()));
    }

    #[test]
    fn chunk_limit_is_separate_from_total_project_size() {
        let task = json!({
            "key": "k",
            "dataset_id": "d",
            "feature_key": "f",
            "part_index": 0,
            "request": {"crs": "EPSG:32650"}
        });
        assert!(validate_tasks(Value::Array(vec![task.clone(); MAX_TASKS_PER_CHUNK])).is_ok());
        assert!(validate_tasks(Value::Array(vec![task; MAX_TASKS_PER_CHUNK + 1])).is_err());
    }
}
