from typing import Optional
from dataclasses import dataclass
from base import Tool
from os import path

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
        mode: str
        outdir: str
        entrypoint: str
        config_file_path: str
        timeout: Optional[int] = None
        core: Optional[int] = None

    def run(self, args: RunArgs) -> str:
        logfile = path.join(args.outdir, "logs.txt")

        port = find_open_port()

        cmd = []

        if args.timeout is not None:
            cmd += ["timeout", "-s", "KILL", f"{args.timeout}s"]

        cmd += [
            "cargo", "run", "--release", "--bin", "railcar", "--",
            "--outdir", args.outdir,
            "--mode", args.mode,
            "--seed", str(args.seed),
            "--port", str(port),
            "--config", args.config_file_path,
        ]

        if args.core is not None:
            cmd += ["--cores", str(args.core)]

        cmd += [args.entrypoint]

        with open(logfile, "a") as f:
            sp.run(cmd, stderr=sp.STDOUT, stdout=f)
