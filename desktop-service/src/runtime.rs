use std::path::{Path, PathBuf};

/// 描述桌面程序随附的引擎和 GDAL/PROJ 资源位置。
#[derive(Clone, Debug)]
pub struct RuntimeContext {
    resource_dir: Option<PathBuf>,
    development_root: PathBuf,
}

impl RuntimeContext {
    /// `resource_dir` 由桌面适配传入，指向客户端随包资源目录。
    pub fn new(resource_dir: Option<PathBuf>) -> Self {
        Self {
            resource_dir,
            development_root: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap_or(Path::new("."))
                .to_path_buf(),
        }
    }
    pub fn resource_dir(&self) -> Option<&Path> {
        self.resource_dir.as_deref()
    }
    pub fn engine_candidates(&self) -> Vec<PathBuf> {
        let mut result = Vec::new();
        if let Some(root) = &self.resource_dir {
            result.push(root.join("engine").join(engine_name()));
        }
        for profile in ["release", "debug"] {
            result.push(
                self.development_root
                    .join("target")
                    .join(profile)
                    .join(engine_name()),
            );
        }
        result
    }
    pub fn gis_candidates(&self) -> Vec<PathBuf> {
        if let Some(root) = &self.resource_dir {
            return vec![root.join("gis")];
        }
        vec![self
            .development_root
            .join("desktop-tauri")
            .join("src-tauri")
            .join("resources")
            .join("gis")]
    }
    pub fn catalog_candidates(&self) -> Vec<PathBuf> {
        if let Some(root) = &self.resource_dir {
            return vec![root.join("catalog.json")];
        }
        vec![self
            .development_root
            .join("desktop-tauri")
            .join("src-tauri")
            .join("resources")
            .join("catalog.json")]
    }
}
#[cfg(windows)]
fn engine_name() -> &'static str {
    "road-geometry-engine.exe"
}
#[cfg(not(windows))]
fn engine_name() -> &'static str {
    "road-geometry-engine"
}
