//! Loopback / token auth for the HTTP service.
//!
//! The server binds loopback by default and needs no auth. A non-loopback bind
//! (explicit `--host` or `server.bind`) requires a bearer token. The token is
//! generated once, stored in the data directory, and printed at startup so a
//! remote user can copy it; it is never written to logs or config.

use std::{fs, path::Path, sync::Arc};

use anyhow::{Context, Result};
use rand::RngCore;

const TOKEN_FILE: &str = "server_token";

/// Returns whether `bind` is a loopback address (no token required).
pub fn is_loopback(bind: &str) -> bool {
    matches!(bind.trim(), "127.0.0.1" | "::1" | "localhost")
}

/// Loads (or creates) the persistent bearer token in `data_dir`.
pub fn load_or_create_token(data_dir: &Path) -> Result<String> {
    let path = data_dir.join(TOKEN_FILE);
    if let Ok(token) = fs::read_to_string(&path) {
        let token = token.trim().to_owned();
        if !token.is_empty() {
            return Ok(token);
        }
    }
    fs::create_dir_all(data_dir)
        .with_context(|| format!("cannot create data directory {}", data_dir.display()))?;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    fs::write(&path, &token)
        .with_context(|| format!("cannot write server token {}", path.display()))?;
    Ok(token)
}

/// Shared auth handle passed to handlers.
#[derive(Clone)]
pub struct Auth {
    /// `None` means loopback-only: every request is allowed.
    token: Option<Arc<str>>,
}

impl Auth {
    pub fn new(bind: &str, data_dir: &Path) -> Result<(Self, bool)> {
        if is_loopback(bind) {
            return Ok((Self { token: None }, false));
        }
        let token = load_or_create_token(data_dir)?;
        Ok((
            Self {
                token: Some(Arc::from(token.as_str())),
            },
            true,
        ))
    }

    /// Checks an optional `Authorization: Bearer <token>` header value.
    pub fn check(&self, bearer: Option<&str>) -> bool {
        match (&self.token, bearer) {
            (None, _) => true,
            (Some(expected), Some(provided)) => {
                provided.strip_prefix("Bearer ").is_some_and(|value| {
                    // Constant-time comparison to avoid leaking the token via
                    // timing over a remote link.
                    let a = value.as_bytes();
                    let b = expected.as_bytes();
                    a.len() == b.len()
                        && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
                })
            }
            _ => false,
        }
    }

    pub fn enabled(&self) -> bool {
        self.token.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn loopback_requires_no_token() {
        for bind in ["127.0.0.1", "::1", "localhost"] {
            let dir = TempDir::new().unwrap();
            let (auth, enabled) = Auth::new(bind, dir.path()).unwrap();
            assert!(!enabled);
            assert!(!auth.enabled());
            assert!(auth.check(None));
            assert!(auth.check(Some("Bearer anything")));
        }
    }

    #[test]
    fn non_loopback_persists_token_and_requires_it() {
        let dir = TempDir::new().unwrap();
        let (auth, enabled) = Auth::new("0.0.0.0", dir.path()).unwrap();
        assert!(enabled);
        assert!(auth.enabled());
        assert!(!auth.check(None));
        assert!(!auth.check(Some("Bearer wrong")));

        // Token persists across "restarts".
        let (auth2, _) = Auth::new("0.0.0.0", dir.path()).unwrap();
        let token = fs::read_to_string(dir.path().join(TOKEN_FILE)).unwrap();
        assert!(auth.check(Some(&format!("Bearer {token}"))));
        assert!(auth2.check(Some(&format!("Bearer {token}"))));
    }
}
