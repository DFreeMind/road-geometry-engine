use serde::{Deserialize, Serialize};

#[cfg(windows)]
const CREDENTIAL_SERVICE: &str = "com.roadgeometry.lujing.database";
const MAX_CONNECTION_ID_BYTES: usize = 36;
const MAX_IDENTITY_BYTES: usize = 1_024;
const MAX_PASSWORD_BYTES: usize = 1_024;
const MAX_CREDENTIAL_BYTES: usize = 2_400;

#[derive(Deserialize, Serialize, PartialEq, Eq)]
struct StoredCredential {
    version: u8,
    identity: String,
    password: String,
}

#[derive(PartialEq, Eq)]
enum DecodedCredential {
    Match(String),
    Stale,
}

pub async fn read_connection_password(
    connection_id: String,
    identity: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        validate_request(&connection_id, &identity, None)?;
        read_connection_password_blocking(&connection_id, &identity)
    })
    .await
    .map_err(|_| "系统凭据读取任务失败".to_string())?
}

pub async fn store_connection_password(
    connection_id: String,
    identity: String,
    password: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        validate_request(&connection_id, &identity, Some(&password))?;
        store_connection_password_blocking(&connection_id, &identity, &password)
    })
    .await
    .map_err(|_| "系统凭据保存任务失败".to_string())?
}

pub async fn delete_connection_password(connection_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        validate_connection_id(&connection_id)?;
        delete_connection_password_blocking(&connection_id)
    })
    .await
    .map_err(|_| "系统凭据删除任务失败".to_string())?
}

fn validate_request(
    connection_id: &str,
    identity: &str,
    password: Option<&str>,
) -> Result<(), String> {
    validate_connection_id(connection_id)?;
    if identity.is_empty() || identity.len() > MAX_IDENTITY_BYTES {
        return Err("连接身份长度无效".into());
    }
    if let Some(password) = password {
        if password.len() > MAX_PASSWORD_BYTES {
            return Err("数据库密码超过系统凭据长度上限".into());
        }
        let payload = encode_credential(identity, password)?;
        if payload.len() > MAX_CREDENTIAL_BYTES {
            return Err("凭据内容超过系统凭据长度上限".into());
        }
    }
    Ok(())
}

fn validate_connection_id(connection_id: &str) -> Result<(), String> {
    let bytes = connection_id.as_bytes();
    let valid = bytes.len() == MAX_CONNECTION_ID_BYTES
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if valid {
        Ok(())
    } else {
        Err("连接编号必须是标准 UUID".into())
    }
}

fn encode_credential(identity: &str, password: &str) -> Result<String, String> {
    serde_json::to_string(&StoredCredential {
        version: 1,
        identity: identity.to_string(),
        password: password.to_string(),
    })
    .map_err(|_| "系统凭据序列化失败".to_string())
}

fn decode_credential(payload: &str, expected_identity: &str) -> Result<DecodedCredential, String> {
    let stored: StoredCredential =
        serde_json::from_str(payload).map_err(|_| "系统凭据格式无效".to_string())?;
    if stored.version != 1 || stored.identity != expected_identity {
        return Ok(DecodedCredential::Stale);
    }
    Ok(DecodedCredential::Match(stored.password))
}

#[cfg(windows)]
fn read_connection_password_blocking(
    connection_id: &str,
    identity: &str,
) -> Result<Option<String>, String> {
    let entry = credential_entry(connection_id)?;
    let payload = match entry.get_password() {
        Ok(payload) => payload,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => return Err("无法从 Windows Credential Manager 读取数据库凭据".into()),
    };
    match decode_credential(&payload, identity)? {
        DecodedCredential::Match(password) => Ok(Some(password)),
        DecodedCredential::Stale => {
            delete_entry(&entry)?;
            Ok(None)
        }
    }
}

#[cfg(not(windows))]
fn read_connection_password_blocking(
    _connection_id: &str,
    _identity: &str,
) -> Result<Option<String>, String> {
    Err("当前平台不支持系统凭据存储".into())
}

#[cfg(windows)]
fn store_connection_password_blocking(
    connection_id: &str,
    identity: &str,
    password: &str,
) -> Result<(), String> {
    let entry = credential_entry(connection_id)?;
    let payload = encode_credential(identity, password)?;
    entry
        .set_password(&payload)
        .map_err(|_| "无法将数据库凭据保存到 Windows Credential Manager".into())
}

#[cfg(not(windows))]
fn store_connection_password_blocking(
    _connection_id: &str,
    _identity: &str,
    _password: &str,
) -> Result<(), String> {
    Err("当前平台不支持系统凭据存储".into())
}

#[cfg(windows)]
fn delete_connection_password_blocking(connection_id: &str) -> Result<(), String> {
    let entry = credential_entry(connection_id)?;
    delete_entry(&entry)
}

#[cfg(not(windows))]
fn delete_connection_password_blocking(_connection_id: &str) -> Result<(), String> {
    Err("当前平台不支持系统凭据存储".into())
}

#[cfg(windows)]
fn credential_entry(connection_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, connection_id)
        .map_err(|_| "无法访问 Windows Credential Manager".into())
}

#[cfg(windows)]
fn delete_entry(entry: &keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法从 Windows Credential Manager 删除数据库凭据".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_credential, encode_credential, validate_connection_id, validate_request,
        DecodedCredential, StoredCredential, MAX_IDENTITY_BYTES, MAX_PASSWORD_BYTES,
    };

    const VALID_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";

    #[test]
    fn credential_json_round_trips_and_never_contains_extra_fields() {
        let payload = encode_credential("[\"postgis\",{}]", "secure-password").unwrap();
        let stored: StoredCredential = serde_json::from_str(&payload).unwrap();
        assert_eq!(stored.version, 1);
        assert_eq!(stored.identity, "[\"postgis\",{}]");
        assert_eq!(stored.password, "secure-password");
        assert!(matches!(
            decode_credential(&payload, "[\"postgis\",{}]").unwrap(),
            DecodedCredential::Match(password) if password == "secure-password"
        ));
    }

    #[test]
    fn identity_mismatch_or_old_version_is_stale() {
        let payload = encode_credential("identity-a", "password").unwrap();
        assert!(matches!(
            decode_credential(&payload, "identity-b").unwrap(),
            DecodedCredential::Stale
        ));
        let old = serde_json::json!({
            "version": 0,
            "identity": "identity-a",
            "password": "password"
        })
        .to_string();
        assert!(matches!(
            decode_credential(&old, "identity-a").unwrap(),
            DecodedCredential::Stale
        ));
        assert!(decode_credential("not-json", "identity-a").is_err());
    }

    #[test]
    fn inputs_require_uuid_and_enforce_byte_limits() {
        assert!(validate_connection_id(VALID_ID).is_ok());
        assert!(validate_connection_id("../credential").is_err());
        assert!(validate_connection_id("01234567-89ab-cdef-0123-456789abcdeg").is_err());
        assert!(validate_request(VALID_ID, "identity", Some("password")).is_ok());
        assert!(validate_request(VALID_ID, "", None).is_err());
        assert!(validate_request(VALID_ID, &"i".repeat(MAX_IDENTITY_BYTES + 1), None).is_err());
        assert!(validate_request(
            VALID_ID,
            "identity",
            Some(&"p".repeat(MAX_PASSWORD_BYTES + 1))
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "需要访问 Windows Credential Manager"]
    fn windows_credential_store_round_trip_and_stale_cleanup() {
        use super::{
            delete_connection_password_blocking, read_connection_password_blocking,
            store_connection_password_blocking,
        };
        use std::time::{SystemTime, UNIX_EPOCH};

        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete_connection_password_blocking(&self.0);
            }
        }

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos()
            % 0x1_0000_0000_0000;
        let connection_id = format!("00000000-0000-4000-8000-{suffix:012x}");
        let _cleanup = Cleanup(connection_id.clone());

        delete_connection_password_blocking(&connection_id).unwrap();
        assert_eq!(
            read_connection_password_blocking(&connection_id, "identity-a").unwrap(),
            None
        );
        store_connection_password_blocking(&connection_id, "identity-a", "").unwrap();
        assert_eq!(
            read_connection_password_blocking(&connection_id, "identity-a").unwrap(),
            Some(String::new())
        );
        assert_eq!(
            read_connection_password_blocking(&connection_id, "identity-b").unwrap(),
            None
        );
        assert_eq!(
            read_connection_password_blocking(&connection_id, "identity-a").unwrap(),
            None
        );
        delete_connection_password_blocking(&connection_id).unwrap();
        delete_connection_password_blocking(&connection_id).unwrap();
    }
}
