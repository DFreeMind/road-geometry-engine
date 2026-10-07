use crate::runtime::RuntimeContext;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 128 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct EngineState {
    jobs: Mutex<HashMap<String, Arc<JobControl>>>,
    shutting_down: AtomicBool,
}

pub(crate) struct JobControl {
    canceled: AtomicBool,
}

impl JobControl {
    pub(crate) fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::SeqCst)
    }

    pub(crate) fn cancel(&self) {
        self.canceled.store(true, Ordering::SeqCst);
    }
}

impl EngineState {
    pub(crate) fn reserve(&self, job_id: &str) -> Result<Arc<JobControl>, String> {
        if job_id.trim().is_empty() || job_id.len() > 200 {
            return Err("job_id 不能为空且长度不得超过 200 个字节".into());
        }
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "引擎任务表已损坏".to_string())?;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("桌面服务正在关闭".into());
        }
        if jobs.contains_key(job_id) {
            return Err(format!("任务 ID 已在运行：{job_id}"));
        }
        let control = Arc::new(JobControl {
            canceled: AtomicBool::new(false),
        });
        jobs.insert(job_id.to_string(), Arc::clone(&control));
        Ok(control)
    }

    pub(crate) fn cancel(&self, job_id: &str) -> bool {
        self.jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(job_id).cloned())
            .map(|control| !control.canceled.swap(true, Ordering::SeqCst))
            .unwrap_or(false)
    }

    pub(crate) fn cancel_all(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(jobs) = self.jobs.lock() {
            for control in jobs.values() {
                control.cancel();
            }
        }
    }

    pub(crate) fn release_if_current(&self, job_id: &str, control: &Arc<JobControl>) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if jobs
                .get(job_id)
                .is_some_and(|current| Arc::ptr_eq(current, control))
            {
                jobs.remove(job_id);
            }
        }
    }
}

pub struct EnginePaths {
    candidates: Vec<PathBuf>,
}

impl EnginePaths {
    pub fn new(context: &RuntimeContext) -> Self {
        Self {
            candidates: context.engine_candidates(),
        }
    }

    /// 为宿主提供显式可执行文件候选路径，避免依赖 Tauri 资源解析。
    pub fn from_paths(candidates: Vec<PathBuf>) -> Self {
        Self { candidates }
    }

    pub fn resolve(&self) -> Result<PathBuf, String> {
        self.candidates
            .iter()
            .find(|path| path.is_file())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "找不到道路几何引擎；已检查开发目录 {}",
                    self.candidates
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join("、")
                )
            })
    }
}

pub(crate) fn run_engine(
    paths: &EnginePaths,
    request: Value,
    control: Arc<JobControl>,
) -> Result<Value, String> {
    let request_bytes =
        serde_json::to_vec(&request).map_err(|error| format!("请求 JSON 无效：{error}"))?;
    if request_bytes.len() > MAX_REQUEST_BYTES {
        return Err(format!("请求超过 {MAX_REQUEST_BYTES} 字节上限"));
    }
    validate_request_crs(&request)?;
    ensure_not_canceled(&control)?;
    let executable = paths.resolve()?;
    let mut command = Command::new(&executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动道路几何引擎 {}：{error}", executable.display()))?;

    let stdout = child.stdout.take().ok_or("无法读取引擎标准输出")?;
    let stderr = child.stderr.take().ok_or("无法读取引擎错误输出")?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, MAX_RESPONSE_BYTES));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, MAX_STDERR_BYTES));
    let input_result = child
        .stdin
        .take()
        .ok_or("无法写入引擎标准输入")?
        .write_all(&request_bytes);
    if let Err(error) = input_result {
        let _ = child.kill();
        let _ = child.wait();
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        return Err(format!("向引擎发送请求失败：{error}"));
    }

    let status = loop {
        if control.canceled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err("道路几何生成已取消".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("读取引擎进程状态失败：{error}"));
            }
        }
    };
    let stdout = join_reader(stdout_reader, "引擎标准输出")?;
    let stderr = join_reader(stderr_reader, "引擎错误输出")?;
    ensure_not_canceled(&control)?;
    if !status.success() {
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("道路几何引擎退出，状态码：{status}")
        } else {
            message
        });
    }
    let response: Value =
        serde_json::from_slice(&stdout).map_err(|error| format!("引擎返回了无效 JSON：{error}"))?;
    if control.canceled.load(Ordering::SeqCst) {
        return Err("道路几何生成已取消".into());
    }
    Ok(response)
}

/// 一个 batch worker 独占一个流式引擎进程；会话在单个 IPC chunk 内复用。
pub(crate) struct EngineSession {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: Receiver<Result<Value, String>>,
    stdout_thread: Option<thread::JoinHandle<()>>,
    stderr_thread: Option<thread::JoinHandle<std::io::Result<Vec<u8>>>>,
    closed: bool,
}

impl EngineSession {
    pub(crate) fn start(paths: &EnginePaths) -> Result<Self, String> {
        let executable = paths.resolve()?;
        let mut command = Command::new(&executable);
        command.arg("--stream");
        Self::spawn(command)
            .map_err(|error| format!("无法启动流式道路几何引擎 {}：{error}", executable.display()))
    }

    fn spawn(mut command: Command) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        let stdin = child.stdin.take().ok_or("无法写入流式引擎标准输入")?;
        let stdout = child.stdout.take().ok_or("无法读取流式引擎标准输出")?;
        let stderr = child.stderr.take().ok_or("无法读取流式引擎错误输出")?;
        let (sender, responses) = mpsc::channel();
        let stdout_thread = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_json_line(&mut reader, MAX_RESPONSE_BYTES) {
                    Ok(Some(bytes)) => {
                        let response = serde_json::from_slice(&bytes)
                            .map_err(|error| format!("流式引擎返回了无效 JSON：{error}"));
                        if sender.send(response).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = sender.send(Err(format!("读取流式引擎响应失败：{error}")));
                        break;
                    }
                }
            }
        });
        // 长会话持续排空 stderr，只保留诊断前缀，避免管道阻塞及无界内存增长。
        let stderr_thread = thread::spawn(move || read_prefix(stderr, MAX_STDERR_BYTES));
        Ok(Self {
            child,
            stdin: Some(stdin),
            responses,
            stdout_thread: Some(stdout_thread),
            stderr_thread: Some(stderr_thread),
            closed: false,
        })
    }

    pub(crate) fn execute(
        &mut self,
        request: Value,
        control: &JobControl,
    ) -> Result<Value, String> {
        ensure_not_canceled(control)?;
        validate_request_crs(&request)?;
        if self.closed {
            return Err("流式道路几何引擎会话已关闭".into());
        }
        let request_bytes =
            serde_json::to_vec(&request).map_err(|error| format!("请求 JSON 无效：{error}"))?;
        if request_bytes.len() > MAX_REQUEST_BYTES {
            return Err(format!("请求超过 {MAX_REQUEST_BYTES} 字节上限"));
        }
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "流式道路几何引擎标准输入已关闭".to_string())?;
        if let Err(error) = stdin
            .write_all(&request_bytes)
            .and_then(|()| stdin.write_all(b"\n"))
        {
            self.closed = true;
            self.terminate(true);
            return Err(format!("向流式道路几何引擎发送请求失败：{error}"));
        }

        loop {
            if control.is_canceled() {
                self.terminate(true);
                return Err("道路批量生成已取消".into());
            }
            match self.responses.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(envelope)) => match decode_stream_response(envelope) {
                    Ok(Ok(response)) => return Ok(response),
                    Ok(Err(task_error)) => return Err(task_error),
                    Err(protocol_error) => {
                        self.terminate(true);
                        return Err(protocol_error);
                    }
                },
                Ok(Err(error)) => {
                    self.terminate(true);
                    return Err(error);
                }
                Err(RecvTimeoutError::Timeout) => match self.child.try_wait() {
                    Ok(Some(status)) => {
                        self.closed = true;
                        if let Some(reader) = self.stdout_thread.take() {
                            let _ = reader.join();
                        }
                        let stderr = self.collect_stderr();
                        let detail = stderr.trim();
                        return Err(if detail.is_empty() {
                            format!("流式道路几何引擎提前退出，状态码：{status}")
                        } else {
                            detail.to_string()
                        });
                    }
                    Ok(None) => continue,
                    Err(error) => {
                        self.terminate(true);
                        return Err(format!("读取流式引擎进程状态失败：{error}"));
                    }
                },
                Err(RecvTimeoutError::Disconnected) => {
                    self.stdin.take();
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    if let Some(reader) = self.stdout_thread.take() {
                        let _ = reader.join();
                    }
                    let stderr = self.collect_stderr();
                    self.closed = true;
                    let detail = stderr.trim();
                    return Err(if detail.is_empty() {
                        "流式道路几何引擎已关闭输出".into()
                    } else {
                        detail.to_string()
                    });
                }
            }
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed
    }

    pub(crate) fn process_id(&self) -> u32 {
        self.child.id()
    }

    fn collect_stderr(&mut self) -> String {
        self.stderr_thread
            .take()
            .and_then(|reader| reader.join().ok())
            .and_then(Result::ok)
            .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
            .unwrap_or_default()
    }

    fn terminate(&mut self, kill: bool) {
        self.stdin.take();
        if kill {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(reader) = self.stdout_thread.take() {
            let _ = reader.join();
        }
        let _ = self.collect_stderr();
        self.closed = true;
    }
}

impl Drop for EngineSession {
    fn drop(&mut self) {
        if !self.closed {
            self.terminate(true);
        }
    }
}

fn decode_stream_response(envelope: Value) -> Result<Result<Value, String>, String> {
    if let Some(error) = envelope.get("error") {
        return error
            .as_str()
            .map(|message| Err(message.to_string()))
            .ok_or_else(|| "流式引擎 error 字段必须是字符串".into());
    }
    envelope
        .get("response")
        .cloned()
        .map(Ok)
        .ok_or_else(|| "流式引擎响应缺少 response 或 error 字段".into())
}

/// 有界读取一行 JSON；超长行会继续丢弃到换行，避免把后续响应错配给当前任务。
fn read_json_line(reader: &mut impl BufRead, limit: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut output = Vec::with_capacity(limit.min(16 * 1024));
    let mut exceeded = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            if output.is_empty() && !exceeded {
                return Ok(None);
            }
            break;
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        let payload_len = if newline.is_some() { take - 1 } else { take };
        if !exceeded {
            if output.len().saturating_add(payload_len) <= limit {
                output.extend_from_slice(&buffer[..payload_len]);
            } else {
                exceeded = true;
            }
        }
        reader.consume(take);
        if newline.is_some() {
            break;
        }
    }
    if exceeded {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("响应行超过 {limit} 字节上限"),
        ))
    } else {
        Ok(Some(output))
    }
}

fn read_prefix(mut reader: impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(output);
        }
        let remaining = limit.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(remaining)]);
    }
}

fn validate_request_crs(request: &Value) -> Result<(), String> {
    let crs = request
        .get("crs")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "请求必须包含投影米制 crs 标识".to_string())?;
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
        return Err(format!("拒绝地理或不适用的米制 CRS：{crs}"));
    }
    Ok(())
}

fn ensure_not_canceled(control: &JobControl) -> Result<(), String> {
    if control.canceled.load(Ordering::SeqCst) {
        Err("道路几何生成已取消".into())
    } else {
        Ok(())
    }
}

fn read_bounded(mut reader: impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    let mut exceeded = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if output.len() + count <= limit {
            output.extend_from_slice(&buffer[..count]);
        } else {
            exceeded = true;
        }
    }
    if exceeded {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("输出超过 {limit} 字节上限"),
        ))
    } else {
        Ok(output)
    }
}

fn join_reader(
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
    name: &str,
) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| format!("{name}读取线程异常退出"))?
        .map_err(|error| format!("{name}读取失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::BufReader;

    #[test]
    fn active_job_ids_cannot_be_reused_and_cancel_is_idempotent() {
        let state = EngineState::default();
        let control = state.reserve("job-1").unwrap();
        assert!(state.reserve("job-1").is_err());
        assert!(state.cancel("job-1"));
        assert!(!state.cancel("job-1"));
        state.release_if_current("job-1", &control);
        let replacement = state.reserve("job-1").unwrap();
        state.release_if_current("job-1", &control);
        assert!(state.cancel("job-1"));
        state.release_if_current("job-1", &replacement);
        assert!(!state.cancel("job-1"));
    }

    #[test]
    fn shutdown_cancels_active_jobs_and_rejects_new_ones() {
        let state = EngineState::default();
        let active = state.reserve("running").unwrap();
        state.cancel_all();
        assert!(active.is_canceled());
        assert!(state
            .reserve("after-shutdown")
            .err()
            .unwrap()
            .contains("关闭"));
    }

    #[test]
    fn engine_rejects_unprojected_crs_before_process_start() {
        for crs in ["EPSG:4326", "EPSG:4490", "EPSG:3857", "OGC:CRS84"] {
            assert!(validate_request_crs(&serde_json::json!({ "crs": crs })).is_err());
        }
        assert!(validate_request_crs(&serde_json::json!({ "crs": "EPSG:32650" })).is_ok());
        assert!(validate_request_crs(&serde_json::json!({})).is_err());
    }

    #[test]
    fn bounded_reader_drains_but_rejects_oversized_output() {
        assert_eq!(read_bounded(&b"abc"[..], 3).unwrap(), b"abc");
        assert!(read_bounded(&b"abcd"[..], 3).is_err());
    }

    #[test]
    fn bounded_line_reader_discards_overflow_until_next_response() {
        let mut reader = BufReader::new(&b"12345\n{\"ok\":true}\n"[..]);
        assert!(read_json_line(&mut reader, 3).is_err());
        assert_eq!(
            read_json_line(&mut reader, 64).unwrap().unwrap(),
            br#"{"ok":true}"#
        );
        assert!(read_json_line(&mut reader, 64).unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn stream_sessions_reuse_process_and_keep_task_errors_isolated() {
        let command = mock_stream_command();
        let mut session = EngineSession::spawn(command).unwrap();
        let control = JobControl {
            canceled: AtomicBool::new(false),
        };
        let first = session
            .execute(json!({"crs":"EPSG:32650","value":"first"}), &control)
            .unwrap();
        let process_id = first["pid"].as_u64().unwrap();
        assert_eq!(first["echo"]["value"], "first");

        let failed = session.execute(json!({"crs":"EPSG:32650","fail":true}), &control);
        assert_eq!(failed.unwrap_err(), "mock task failure");
        assert!(!session.is_closed());

        let second = session
            .execute(json!({"crs":"EPSG:32650","value":"second"}), &control)
            .unwrap();
        assert_eq!(second["pid"].as_u64(), Some(process_id));
        assert_eq!(second["echo"]["value"], "second");
        drop(session);
    }

    #[cfg(windows)]
    #[test]
    fn stream_session_cancellation_kills_a_slow_child_without_waiting_for_stdout() {
        let command = mock_stream_command();
        let mut session = EngineSession::spawn(command).unwrap();
        let control = Arc::new(JobControl {
            canceled: AtomicBool::new(false),
        });
        let cancel_control = Arc::clone(&control);
        let cancel_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancel_control.cancel();
        });
        let started = std::time::Instant::now();
        let result = session.execute(json!({"crs":"EPSG:32650","wait":true}), &control);
        cancel_thread.join().unwrap();
        assert!(result.unwrap_err().contains("已取消"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(session.is_closed());
    }

    #[cfg(windows)]
    fn mock_stream_command() -> Command {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
        command.arg(
            r#"while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = ConvertFrom-Json -InputObject $line
  if ($request.wait) { Start-Sleep -Seconds 3 }
  if ($request.fail) {
    $envelope = @{ error = 'mock task failure' }
  } else {
    $envelope = @{ response = @{ pid = $PID; echo = $request } }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $envelope -Compress -Depth 100))
}"#,
        );
        command
    }
}
