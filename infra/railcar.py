from typing import Optional
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
        mode: str
        outdir: str
        entrypoint: str
        seed: Optional[int] = None
        core: Optional[int] = None
        timeout: Optional[int] = None
        metrics: Optional[str] = None
        labels: Optional[list[str]] = None
        config_file_path: Optional[str] = None

    def run(self, args: RunArgs) -> str:
        port = find_open_port()
        logfile = path.join(args.outdir, "logs.txt")

        cmd = []

        if args.timeout is not None:
            cmd += ["timeout", "-s", "KILL", f"{args.timeout}s"]

        cmd += [
            "cargo", "run", "--release", "--bin", "railcar", "--",
            "--outdir", args.outdir,
            "--mode", args.mode,
            "--port", str(port),
        ]

        if args.metrics is not None:
            cmd += ["--metrics", args.metrics]

        if args.config_file_path is not None:
            cmd += ["--config", args.config_file_path]

        if args.seed is not None:
            cmd += ["--seed", str(args.seed)]

        if args.labels is not None:
            for label in args.labels:
                cmd += ["--label", str(label)]

        if args.core is not None:
            cmd += ["--cores", str(args.core)]

        cmd += [args.entrypoint]

        makedirs(args.outdir, exist_ok=False)
        with open(logfile, "a") as f:
            sp.run(cmd, stderr=sp.STDOUT, stdout=f)
