use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "generation-issues";
const SNAPSHOT_EVENT: &str = "generation-issues:snapshot";
const ACTION_EVENT: &str = "generation-issues:action";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummaryRow {
    pub id: String,
    pub dataset_id: String,
    pub feature_key: Option<String>,
    pub part_index: Option<u32>,
    pub stage: String,
    pub message: String,
    pub code: String,
    pub source_label: String,
    pub route_label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSnapshot {
    pub revision: u64,
    pub working: bool,
    pub rows: Vec<IssueSummaryRow>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IssueAction {
    Locate { id: String },
    Edit { id: String },
    Mapping { id: String },
    Retry { id: String },
    RetryMany { ids: Vec<String> },
}

#[derive(Default)]
pub struct GenerationIssuesState {
    snapshot: Mutex<Option<IssueSnapshot>>,
    window_lifecycle: Mutex<()>,
}

fn update_snapshot(state: &GenerationIssuesState, snapshot: IssueSnapshot) -> Result<(), String> {
    let mut current = state
        .snapshot
        .lock()
        .map_err(|_| "生成问题窗口状态锁已损坏".to_string())?;
    if current
        .as_ref()
        .is_none_or(|existing| snapshot.revision >= existing.revision)
    {
        *current = Some(snapshot);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_generation_issues_window(
    app: tauri::AppHandle,
    state: State<'_, GenerationIssuesState>,
    window: tauri::WebviewWindow,
    snapshot: IssueSnapshot,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可以打开生成问题窗口".into());
    }
    update_snapshot(state.inner(), snapshot)?;
    let _lifecycle = state
        .window_lifecycle
        .lock()
        .map_err(|_| "生成问题窗口生命周期锁已损坏".to_string())?;

    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window
            .unminimize()
            .map_err(|error| format!("还原生成问题窗口失败：{error}"))?;
        window
            .show()
            .map_err(|error| format!("显示生成问题窗口失败：{error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("聚焦生成问题窗口失败：{error}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        WebviewUrl::App("index.html?window=generation-issues".into()),
    )
    .title("路境 · 生成问题")
    .inner_size(960.0, 720.0)
    .min_inner_size(520.0, 360.0)
    .resizable(true)
    .decorations(false)
    .build()
    .map(|_| ())
    .map_err(|error| format!("创建生成问题窗口失败：{error}"))
}

#[tauri::command]
pub fn sync_generation_issues_window(
    app: tauri::AppHandle,
    state: State<'_, GenerationIssuesState>,
    window: tauri::WebviewWindow,
    snapshot: IssueSnapshot,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可以同步生成问题摘要".into());
    }
    update_snapshot(state.inner(), snapshot)?;
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        let current = state
            .snapshot
            .lock()
            .map_err(|_| "生成问题窗口状态锁已损坏".to_string())?
            .clone();
        if let Some(current) = current {
            app.emit_to(WINDOW_LABEL, SNAPSHOT_EVENT, current)
                .map_err(|error| format!("同步生成问题摘要失败：{error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_generation_issues_snapshot(
    window: tauri::WebviewWindow,
    state: State<'_, GenerationIssuesState>,
) -> Result<Option<IssueSnapshot>, String> {
    if window.label() != WINDOW_LABEL {
        return Err("仅生成问题窗口可以读取问题摘要".into());
    }
    state
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .map_err(|_| "生成问题窗口状态锁已损坏".to_string())
}

#[tauri::command]
pub fn submit_generation_issue_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: IssueAction,
) -> Result<(), String> {
    if window.label() != WINDOW_LABEL {
        return Err("仅生成问题窗口可以提交问题操作".into());
    }
    app.emit_to("main", ACTION_EVENT, action)
        .map_err(|error| format!("发送生成问题操作失败：{error}"))
}

#[tauri::command]
pub fn minimize_generation_issues_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != WINDOW_LABEL {
        return Err("仅生成问题窗口可以执行最小化".into());
    }
    window
        .minimize()
        .map_err(|error| format!("最小化生成问题窗口失败：{error}"))
}

#[tauri::command]
pub fn start_dragging_generation_issues_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != WINDOW_LABEL {
        return Err("仅生成问题窗口可以移动".into());
    }
    window
        .start_dragging()
        .map_err(|error| format!("移动生成问题窗口失败：{error}"))
}

#[tauri::command]
pub fn close_generation_issues_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != WINDOW_LABEL {
        return Err("仅生成问题窗口可以执行关闭".into());
    }
    window
        .close()
        .map_err(|error| format!("关闭生成问题窗口失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_snapshot_does_not_replace_newer_rows() {
        let state = GenerationIssuesState::default();
        update_snapshot(
            &state,
            IssueSnapshot {
                revision: 10,
                working: true,
                rows: vec![],
            },
        )
        .unwrap();
        update_snapshot(
            &state,
            IssueSnapshot {
                revision: 9,
                working: false,
                rows: vec![],
            },
        )
        .unwrap();
        let value = state.snapshot.lock().unwrap();
        assert_eq!(value.as_ref().unwrap().revision, 10);
        assert!(value.as_ref().unwrap().working);
    }

    #[test]
    fn snapshot_does_not_retain_project_or_geometry_fields() {
        let input = serde_json::json!({"revision": 1, "working": false, "rows": [], "project": {"geometry": [[1,2]]}});
        let summary: IssueSnapshot = serde_json::from_value(input).unwrap();
        let output = serde_json::to_value(summary).unwrap();
        assert!(output.get("project").is_none());
    }
}
