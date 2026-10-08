use std::time::Duration;

use tauri::{ipc::Response, State};
use tokio::sync::Semaphore;

const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;

pub struct EsriTiles {
    client: reqwest::Client,
    slots: Semaphore,
}

impl EsriTiles {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            // 仅此客户端直连 Esri；不改变 WebView2、系统代理和其他服务。
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(12))
                .user_agent("Lujing/0.2 Esri viewport tiles")
                .build()?,
            slots: Semaphore::new(8),
        })
    }
}

fn tile_url(layer: &str, z: u32, x: u32, y: u32) -> Result<String, String> {
    let (service, max_zoom) = match layer {
        "imagery" => ("World_Imagery", 19),
        "hillshade" => ("Elevation/World_Hillshade", 16),
        _ => return Err("不支持该 Esri 图层".into()),
    };
    if z > max_zoom || x >= (1_u32 << z) || y >= (1_u32 << z) {
        return Err("Esri 瓦片坐标超出范围".into());
    }
    Ok(format!(
        "https://server.arcgisonline.com/ArcGIS/rest/services/{service}/MapServer/tile/{z}/{y}/{x}"
    ))
}

fn validate_image(data: &[u8]) -> Result<(), String> {
    if data.len() > MAX_TILE_BYTES {
        return Err("Esri 瓦片超过大小上限".into());
    }
    if !data.starts_with(&[0xff, 0xd8, 0xff]) && !data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Esri 未返回 JPEG 或 PNG 影像".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn esri_tile(
    state: State<'_, EsriTiles>,
    layer: String,
    z: u32,
    x: u32,
    y: u32,
) -> Result<Response, String> {
    let url = tile_url(&layer, z, x, y)?;
    // 使用异步 I/O 和有界并发，重型请求不占用界面线程。
    let _slot = state.slots.acquire().await.map_err(|_| "影像请求已停止")?;
    let mut response = state.client.get(url).send().await.map_err(|error| {
        if error.is_timeout() {
            "Esri 直连请求超时".to_string()
        } else {
            "Esri 直连请求失败，请检查网络连接".to_string()
        }
    })?;
    if !response.status().is_success() {
        return Err(format!("Esri 服务返回 HTTP {}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_TILE_BYTES as u64)
    {
        return Err("Esri 瓦片超过大小上限".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取 Esri 瓦片失败")? {
        if data.len() + chunk.len() > MAX_TILE_BYTES {
            return Err("Esri 瓦片超过大小上限".into());
        }
        data.extend_from_slice(&chunk);
    }
    validate_image(&data)?;
    Ok(Response::new(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_service_and_tile_extent() {
        assert!(tile_url("https://other.example", 0, 0, 0).is_err());
        assert!(tile_url("imagery", 20, 0, 0).is_err());
        assert!(tile_url("imagery", 3, 8, 0).is_err());
        assert!(tile_url("imagery", 3, 0, 8).is_err());
        assert!(tile_url("imagery", 32, 0, 0).is_err());
        assert!(tile_url("hillshade", 16, 65535, 65535).is_ok());
        assert!(tile_url("imagery", 3, 2, 5)
            .unwrap()
            .ends_with("/tile/3/5/2"));
    }

    #[test]
    fn rejects_denial_pages_and_oversized_images() {
        assert!(validate_image(b"<html>Access Denied</html>").is_err());
        assert!(validate_image(&[]).is_err());
        assert!(validate_image(&vec![0xff; MAX_TILE_BYTES + 1]).is_err());
        assert!(validate_image(&[0xff, 0xd8, 0xff, 0xe0]).is_ok());
        assert!(validate_image(b"\x89PNG\r\n\x1a\nrest").is_ok());
    }
}
