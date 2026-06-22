use std::ffi::OsStr;
use std::path::Path;

use tauri::async_runtime::Receiver;
use tauri::AppHandle;
use tauri_plugin_shell::process::Command as ShellCommand;
#[cfg(not(windows))]
use tauri_plugin_shell::process::CommandChild as ShellCommandChild;
pub use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

pub type SupervisedProcessReceiver = Receiver<CommandEvent>;
pub const ALLOW_EXTERNAL_RUNTIME_BINARIES_ENV: &str =
    "VESLO_DESKTOP_ALLOW_EXTERNAL_RUNTIME_BINARIES";

#[derive(Debug)]
pub struct SupervisedCommand {
    inner: ShellCommand,
}

#[derive(Debug)]
pub struct SupervisedCommandChild {
    inner: SupervisedCommandChildInner,
}

#[derive(Debug)]
enum SupervisedCommandChildInner {
    #[cfg(not(windows))]
    Shell(ShellCommandChild),
    #[cfg(windows)]
    Native(windows::NativeCommandChild),
}

pub fn command<S>(app: &AppHandle, program: S) -> SupervisedCommand
where
    S: AsRef<OsStr>,
{
    SupervisedCommand::from_shell(app.shell().command(program))
}

fn parse_env_flag(value: Option<&str>) -> bool {
    matches!(
        value.map(|raw| raw.trim().to_ascii_lowercase()),
        Some(flag) if matches!(flag.as_str(), "1" | "true" | "yes" | "on")
    )
}

pub fn external_runtime_binaries_allowed_from_env(
    value: Option<&str>,
    debug_assertions: bool,
) -> bool {
    debug_assertions || parse_env_flag(value)
}

pub fn external_runtime_binaries_allowed() -> bool {
    external_runtime_binaries_allowed_from_env(
        std::env::var(ALLOW_EXTERNAL_RUNTIME_BINARIES_ENV)
            .ok()
            .as_deref(),
        cfg!(debug_assertions),
    )
}

pub fn command_fallback_for_missing_sidecar<S>(
    app: &AppHandle,
    sidecar_name: &str,
    fallback_program: S,
    sidecar_error: String,
) -> Result<SupervisedCommand, String>
where
    S: AsRef<OsStr>,
{
    let fallback_name = fallback_program.as_ref().to_string_lossy().to_string();
    if external_runtime_binaries_allowed() {
        return Ok(command(app, fallback_program));
    }

    Err(format!(
        "Bundled {sidecar_name} sidecar is unavailable ({sidecar_error}); refusing to run external {fallback_name} from PATH. Set {ALLOW_EXTERNAL_RUNTIME_BINARIES_ENV}=1 only for a developer override."
    ))
}

pub fn sidecar<P>(app: &AppHandle, program: P) -> Result<SupervisedCommand, String>
where
    P: AsRef<Path>,
{
    app.shell()
        .sidecar(program)
        .map(SupervisedCommand::from_shell)
        .map_err(|error| error.to_string())
}

impl SupervisedCommand {
    fn from_shell(command: ShellCommand) -> Self {
        Self { inner: command }
    }

    #[must_use]
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.inner = self.inner.args(args);
        self
    }

    #[must_use]
    pub fn env<K, V>(mut self, key: K, value: V) -> Self
    where
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.inner = self.inner.env(key, value);
        self
    }

    #[must_use]
    pub fn current_dir<P>(mut self, current_dir: P) -> Self
    where
        P: AsRef<Path>,
    {
        self.inner = self.inner.current_dir(current_dir);
        self
    }

    pub fn spawn(self) -> Result<(SupervisedProcessReceiver, SupervisedCommandChild), String> {
        #[cfg(windows)]
        {
            let command: std::process::Command = self.inner.into();
            windows::spawn_hidden_command(command).map(|(rx, child)| {
                (
                    rx,
                    SupervisedCommandChild {
                        inner: SupervisedCommandChildInner::Native(child),
                    },
                )
            })
        }

        #[cfg(not(windows))]
        {
            self.inner
                .spawn()
                .map(|(rx, child)| {
                    (
                        rx,
                        SupervisedCommandChild {
                            inner: SupervisedCommandChildInner::Shell(child),
                        },
                    )
                })
                .map_err(|error| error.to_string())
        }
    }
}

impl SupervisedCommandChild {
    pub fn pid(&self) -> u32 {
        match &self.inner {
            #[cfg(not(windows))]
            SupervisedCommandChildInner::Shell(child) => child.pid(),
            #[cfg(windows)]
            SupervisedCommandChildInner::Native(child) => child.pid(),
        }
    }

    pub fn kill(self) -> Result<(), String> {
        match self.inner {
            #[cfg(not(windows))]
            SupervisedCommandChildInner::Shell(child) => {
                child.kill().map_err(|error| error.to_string())
            }
            #[cfg(windows)]
            SupervisedCommandChildInner::Native(child) => child.kill(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_runtime_binaries_are_allowed_in_debug_builds() {
        assert!(external_runtime_binaries_allowed_from_env(None, true));
        assert!(external_runtime_binaries_allowed_from_env(Some("0"), true));
    }

    #[test]
    fn external_runtime_binaries_require_explicit_release_override() {
        assert!(!external_runtime_binaries_allowed_from_env(None, false));
        assert!(!external_runtime_binaries_allowed_from_env(
            Some("0"),
            false
        ));
        assert!(external_runtime_binaries_allowed_from_env(Some("1"), false));
        assert!(external_runtime_binaries_allowed_from_env(
            Some("true"),
            false
        ));
    }
}

#[cfg(windows)]
mod windows {
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::process::CommandExt;
    use std::process::Command as StdCommand;
    use std::sync::{Arc, RwLock};
    use std::thread;

    use os_pipe::{pipe, PipeReader, PipeWriter};
    use shared_child::SharedChild;
    use tauri::async_runtime::{block_on as block_on_task, channel, Receiver, Sender};
    use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const NEWLINE_BYTE: u8 = b'\n';

    #[derive(Debug)]
    pub struct NativeCommandChild {
        inner: Arc<SharedChild>,
        stdin_writer: PipeWriter,
    }

    impl NativeCommandChild {
        #[allow(dead_code)]
        pub fn write(&mut self, buf: &[u8]) -> Result<(), String> {
            self.stdin_writer
                .write_all(buf)
                .map_err(|error| error.to_string())
        }

        pub fn kill(self) -> Result<(), String> {
            self.inner.kill().map_err(|error| error.to_string())
        }

        pub fn pid(&self) -> u32 {
            self.inner.id()
        }
    }

    pub fn spawn_hidden_command(
        mut command: StdCommand,
    ) -> Result<(Receiver<CommandEvent>, NativeCommandChild), String> {
        let (stdout_reader, stdout_writer) = pipe().map_err(|error| error.to_string())?;
        let (stderr_reader, stderr_writer) = pipe().map_err(|error| error.to_string())?;
        let (stdin_reader, stdin_writer) = pipe().map_err(|error| error.to_string())?;

        command.stdout(stdout_writer);
        command.stderr(stderr_writer);
        command.stdin(stdin_reader);
        command.creation_flags(CREATE_NO_WINDOW);

        let child = Arc::new(SharedChild::spawn(&mut command).map_err(|error| error.to_string())?);
        let wait_child = child.clone();
        let output_guard = Arc::new(RwLock::new(()));
        let (tx, rx) = channel(1);

        spawn_pipe_reader(
            tx.clone(),
            output_guard.clone(),
            stdout_reader,
            CommandEvent::Stdout,
        );
        spawn_pipe_reader(
            tx.clone(),
            output_guard.clone(),
            stderr_reader,
            CommandEvent::Stderr,
        );

        thread::spawn(move || match wait_child.wait() {
            Ok(status) => {
                let _lock = output_guard.write().unwrap();
                send_event(
                    tx,
                    CommandEvent::Terminated(TerminatedPayload {
                        code: status.code(),
                        signal: None,
                    }),
                );
            }
            Err(error) => {
                let _lock = output_guard.write().unwrap();
                send_event(tx, CommandEvent::Error(error.to_string()));
            }
        });

        Ok((
            rx,
            NativeCommandChild {
                inner: child,
                stdin_writer,
            },
        ))
    }

    fn spawn_pipe_reader(
        tx: Sender<CommandEvent>,
        guard: Arc<RwLock<()>>,
        reader: PipeReader,
        event: fn(Vec<u8>) -> CommandEvent,
    ) {
        thread::spawn(move || {
            let _lock = guard.read().unwrap();
            let mut reader = BufReader::new(reader);
            loop {
                let mut buffer = Vec::new();
                match reader.read_until(NEWLINE_BYTE, &mut buffer) {
                    Ok(0) => break,
                    Ok(_) => send_event(tx.clone(), event(buffer)),
                    Err(error) => {
                        send_event(tx.clone(), CommandEvent::Error(error.to_string()));
                        break;
                    }
                }
            }
        });
    }

    fn send_event(tx: Sender<CommandEvent>, event: CommandEvent) {
        let _ = block_on_task(async move { tx.send(event).await });
    }
}
