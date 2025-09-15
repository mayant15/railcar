from dataclasses import dataclass
from base import Tool
from os import path, makedirs

import subprocess as sp
import socket


def find_open_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Railcar(Tool):

    @dataclass
    class RunArgs:
        seed: int
        core: int
        mode: str
        timeout: int
        outdir: str
        entrypoint: str
        config_file_path: str

    def run(self, args: RunArgs) -> str:
        coverage_dir = path.join(args.outdir, "coverage")
        crashes_dir = path.join(args.outdir, "crashes")
        corpus_dir = path.join(args.outdir, "corpus")
        metrics = path.join(args.outdir, "metrics.db")
        logfile = path.join(args.outdir, "logs.txt")

        makedirs(coverage_dir, exist_ok=True)
        makedirs(crashes_dir, exist_ok=True)
        makedirs(corpus_dir, exist_ok=True)

        port = find_open_port()

        cmd = [
            "timeout", "-s", "KILL", f"{args.timeout}s",
            "cargo", "run", "--release", "--bin", "railcar", "--",
            "--corpus", corpus_dir,
            "--crashes", crashes_dir,
            "--mode", args.mode,
            "--metrics", metrics,
            "--seed", str(args.seed),
            "--cores", str(args.core),
            "--port", str(port),
            "--config", args.config_file_path,
            args.entrypoint
        ]

        with open(logfile, "a") as f:
            sp.run(cmd, stderr=sp.STDOUT, stdout=f)
