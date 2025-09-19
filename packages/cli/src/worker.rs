// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{
    io::{self, Read, Write},
    os::{
        fd::{AsFd, AsRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    path::PathBuf,
    process::Command,
};

use anyhow::{bail, Result};
use libafl_bolts::shmem::{MmapShMem, MmapShMemProvider, ShMem, ShMemDescription, ShMemProvider};
use nix::{
    sys::wait::WaitStatus,
    unistd::{ForkResult, Pid},
};
use railcar_graph::Schema;
use serde::{Deserialize, Serialize};

use crate::{client::FuzzerMode, config::COVERAGE_MAP_SIZE};

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
    coverage: Option<ShMemDescription>,
    replay: bool,
    config_file: PathBuf,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkerArgs {
    pub mode: FuzzerMode,
    pub entrypoint: PathBuf,
    pub schema_file: Option<PathBuf>,
    pub replay: bool,
    pub config_file: PathBuf,
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
    coverage: Option<MmapShMem>,
}

/// Spawn a NodeJS subprocess to run the target
///
/// In case the fuzzer exits (crash or timeout), the default LibAFL signal handler calls
/// `libc::exit`. When simply invoked with a `Command::spawn`, this didn't close the child
/// process. Set a death signal with `set_pdeathsig` so that we send a SIGKILL to the child
/// process when the fuzzer process terminates for any reason. This also pipes stdout and
/// stdin of the child process for IPC.
fn spawn_node_child() -> Result<Child> {
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

            unistd::dup2(in_read.as_raw_fd(), 0).expect("failed to set stdin");
            unistd::dup2(out_write.as_raw_fd(), 1).expect("failed to set stdout");

            let err = Command::new("node").arg(worker_script).exec();
            panic!("failed to spawn node subprocess: {}", err);
        }
    }
}

impl Worker {
    pub fn new(args: WorkerArgs) -> Result<Self> {
        let coverage = if args.replay {
            // we don't need coverage maps for replay
            None
        } else {
            // MmapShMemProvider is stateless, don't need to save it. Can create new
            // providers as required (see Self::release_shmem)
            let mut shmem_provider = MmapShMemProvider::new()?;
            Some(shmem_provider.new_shmem(COVERAGE_MAP_SIZE)?)
        };

        let proc = spawn_node_child()?;

        let mut worker = Self {
            proc,
            coverage,
            schema: None,
        };

        worker.send(Message::Init(InitArgs {
            mode: args.mode,
            entrypoint: args.entrypoint,
            schema_file: args.schema_file,
            replay: args.replay,
            coverage: worker.coverage.as_ref().map(|c| c.description()),
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

    pub fn coverage_mut(&mut self) -> Option<&mut MmapShMem> {
        self.coverage.as_mut()
    }

    fn release_shmem(&mut self) -> Result<()> {
        if let Some(coverage) = self.coverage_mut() {
            let mut provider = MmapShMemProvider::new()?;
            provider.release_shmem(coverage);
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
