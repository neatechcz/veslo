use std::ffi::OsString;
use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn lock_env() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct EnvVarGuard {
    originals: Vec<(&'static str, Option<OsString>)>,
    _lock: MutexGuard<'static, ()>,
}

impl EnvVarGuard {
    pub fn apply(key: &'static str, value: Option<&str>) -> Self {
        Self::apply_many(&[(key, value)])
    }

    pub fn apply_many(values: &[(&'static str, Option<&str>)]) -> Self {
        let lock = lock_env();
        let mut originals = Vec::with_capacity(values.len());
        for (key, value) in values {
            originals.push((*key, std::env::var_os(key)));
            match value {
                Some(next) if !next.trim().is_empty() => {
                    std::env::set_var(key, next.trim());
                }
                _ => {
                    std::env::remove_var(key);
                }
            }
        }
        Self {
            originals,
            _lock: lock,
        }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        for (key, original) in self.originals.iter().rev() {
            match original {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}
