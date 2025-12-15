// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{
    io::{self, Read, Write},
    os::{
        fd::{AsFd, AsRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    path::PathBuf,
    process::{Command, Stdio},
};

use anyhow::{bail, Result};
use libafl_bolts::shmem::{ShMem, ShMemDescription, ShMemProvider, StdShMem, StdShMemProvider};
use nix::{
    sys::wait::WaitStatus,
    unistd::{ForkResult, Pid},
};
use serde::{Deserialize, Serialize};

use crate::{schema::Schema, shmem::ShMemView, FuzzerConfig, FuzzerMode};

#[derive(Serialize, Deserialize, Debug)]
pub struct InvokeArgs {
    #[serde(with = "serde_bytes")]
    bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InitArgs {
    mode: FuzzerMode,
    entrypoint: PathBuf,
    schema_file: Option<PathBuf>,
    shmem: Option<ShMemDescription>,
    replay: bool,
    config_file: Option<PathBuf>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkerArgs {
    pub mode: FuzzerMode,
    pub entrypoint: PathBuf,
    pub schema_file: Option<PathBuf>,
    pub replay: bool,
    pub config_file: Option<PathBuf>,
}

type ExitCode = u8;

// NOTE: Keep in sync with worker/worker.ts
#[derive(Serialize, Deserialize, Debug)]
pub enum Message {
    Init(InitArgs),
    InitOk(Option<Schema>),
    Invoke(InvokeArgs),
    InvokeOk(ExitCode),
    Log(String),
    Terminate,
}

fn find_node_modules() -> Result<PathBuf> {
    let mut dir_opt = std::env::current_dir().ok();
    while let Some(dir) = dir_opt.as_mut() {
        dir.push("node_modules");
        if dir.exists() && dir.is_dir() {
            return Ok(dir.to_path_buf());
        } else {
            dir.pop();
            dir.pop();
        }
    }
    bail!("failed to find node_modules")
}

// TODO: Cannot run this through npx because we want the node worker to be a direct child
// of the fuzzer process. Is there a better way to do this?
fn find_worker_script() -> Result<PathBuf> {
    let mut path = find_node_modules()?;
    path.push(".bin");
    path.push("railcar-worker");
    Ok(path)
}

struct PipeWriter(OwnedFd);
struct PipeReader(OwnedFd);

impl Read for PipeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let size = nix::unistd::read(self.0.as_raw_fd(), buf)?;
        Ok(size)
    }
}

impl Write for PipeWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let size = nix::unistd::write(self.0.as_fd(), buf)?;
        Ok(size)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Child {
    pid: Pid,
    stdin: PipeWriter,
    stdout: PipeReader,
}

impl Child {
    fn wait(&self) -> Result<WaitStatus> {
        let status = nix::sys::wait::waitpid(self.pid, None)?;
        assert!(matches!(
            status,
            WaitStatus::Exited(_, _) | WaitStatus::Signaled(_, _, _)
        ));
        Ok(status)
    }
}

pub struct Worker {
    proc: Child,
    schema: Option<Schema>,
    shmem: Option<StdShMem>,
}

struct SpawnNodeChildOptions {
    discard_stderr: bool,
}

/// Spawn a NodeJS subprocess to run the target
///
/// In case the fuzzer exits (crash or timeout), the default LibAFL signal handler calls
/// `libc::exit`. When simply invoked with a `Command::spawn`, this didn't close the child
/// process. Set a death signal with `set_pdeathsig` so that we send a SIGKILL to the child
/// process when the fuzzer process terminates for any reason. This also pipes stdout and
/// stdin of the child process for IPC.
fn spawn_node_child(opts: SpawnNodeChildOptions) -> Result<Child> {
    use nix::unistd;

    let worker_script = find_worker_script()?;

    let (in_read, in_write) = unistd::pipe()?;
    let (out_read, out_write) = unistd::pipe()?;
    let result = unsafe { unistd::fork() }?;
    match result {
        ForkResult::Parent { child } => {
            drop(in_read);
            drop(out_write);

            Ok(Child {
                pid: child,
                stdout: PipeReader(out_read),
                stdin: PipeWriter(in_write),
            })
        }
        ForkResult::Child => {
            use nix::sys::{prctl, signal::Signal};

            prctl::set_pdeathsig(Signal::SIGKILL).expect("failed to set death signal");

            drop(in_write);
            drop(out_read);

            let stderr = if opts.discard_stderr {
                Stdio::null()
            } else {
                Stdio::inherit()
            };

            let err = Command::new("node")
                .arg(worker_script)
                .stdin(Stdio::from(in_read))
                .stdout(Stdio::from(out_write))
                .stderr(stderr)
                .exec();
            panic!("failed to spawn node subprocess: {}", err);
        }
    }
}

impl Worker {
    pub fn new(args: WorkerArgs) -> Result<Self> {
        let shmem = if args.replay {
            // we don't need any shmem for replay
            None
        } else {
            // StdShMemProvider is stateless, don't need to save it. Can create new
            // providers as required (see Self::release_shmem)
            let mut provider = StdShMemProvider::new()?;
            Some(ShMemView::alloc(&mut provider)?)
        };

        let proc = spawn_node_child(SpawnNodeChildOptions {
            discard_stderr: !cfg!(debug_assertions),
        })?;

        let mut worker = Self {
            proc,
            shmem,
            schema: None,
        };

        worker.send(Message::Init(InitArgs {
            mode: args.mode,
            entrypoint: args.entrypoint,
            schema_file: args.schema_file,
            replay: args.replay,
            shmem: worker.shmem.as_ref().map(|c| c.description()),
            config_file: args.config_file,
        }))?;

        let ok = worker.recv()?;

        if let Message::InitOk(schema) = ok {
            worker.schema = schema;
        } else {
            bail!("expected Message::InitOk. received {:?}", ok)
        }

        Ok(worker)
    }

    pub fn send(&mut self, msg: Message) -> io::Result<()> {
        let bytes = rmp_serde::to_vec_named(&msg).map_err(io::Error::other)?;

        self.proc.stdin.write_all(&bytes)?;

        Ok(())
    }

    pub fn recv(&mut self) -> io::Result<Message> {
        loop {
            let msg: Message =
                rmp_serde::from_read(&mut self.proc.stdout).map_err(io::Error::other)?;
            if let Message::Log(msg) = msg {
                log::info!("[worker] {}", msg);
            } else {
                return Ok(msg);
            }
        }
    }

    pub fn invoke(&mut self, buf: &[u8]) -> Result<ExitCode> {
        let msg = Message::Invoke(InvokeArgs {
            bytes: buf.to_vec(),
        });
        self.send(msg)?;
        let ok = self.recv()?;

        if let Message::InvokeOk(code) = ok {
            Ok(code)
        } else {
            bail!("expected Message::InvokeOk(..). received {:?}", ok)
        }
    }

    pub fn schema(&self) -> Option<&Schema> {
        self.schema.as_ref()
    }

    pub fn shmem_mut(&mut self) -> Option<&mut StdShMem> {
        self.shmem.as_mut()
    }

    fn release_shmem(&mut self) -> Result<()> {
        if let Some(shmem) = self.shmem_mut() {
            let mut provider = StdShMemProvider::new()?;
            provider.release_shmem(shmem);
        }
        Ok(())
    }

    /// Try to terminate the process with IPC
    pub fn terminate(&mut self) -> Result<()> {
        if let Err(e) = self.send(Message::Terminate) {
            // assume the process is already dead if broken pipe
            if !matches!(e.kind(), io::ErrorKind::BrokenPipe) {
                self.release_shmem()?;
                bail!("{}", e)
            }
        };
        self.proc.wait()?;
        self.release_shmem()?;
        Ok(())
    }
}

impl From<&FuzzerConfig> for WorkerArgs {
    fn from(config: &FuzzerConfig) -> Self {
        WorkerArgs {
            mode: config.mode.clone(),
            entrypoint: config.entrypoint.clone(),
            schema_file: config.schema_file.clone(),
            replay: config.replay,
            config_file: config.config_file.clone(),
        }
    }
}
