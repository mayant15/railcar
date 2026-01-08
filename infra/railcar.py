from typing import Optional
from dataclasses import dataclass
from base import Tool
from os import path, makedirs

import subprocess as sp
import socket
import json


class FuzzerConfig:
    config_file: str
    cores: list[int]
    corpus: str
    entrypoint: str
    mode: str
    schema: Optional[str]
    seed: int

    def __init__(self, path: str) -> None:
        js = None
        with open(path) as file:
            js = json.load(file)['config']

        self.config_file = js['config_file']
        self.cores = js['cores']['ids']
        self.corpus = js['corpus']
        self.entrypoint = js['entrypoint']
        self.mode = js['mode']
        self.schema = js['schema_file']
        self.seed = js['seed']


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
        schema: Optional[str] = None
        seed: Optional[int] = None
        cores: Optional[list[int]] = None
        timeout: Optional[int] = None
        metrics: Optional[str] = None
        labels: Optional[list[str]] = None
        config_file_path: Optional[str] = None

    @dataclass
    class CoverageArgs:
        run_config_path: str
        coverage_dir: str
        cores: Optional[list[int]] = None


    def coverage(self, args: CoverageArgs):
        conf = FuzzerConfig(args.run_config_path)
        port = find_open_port()
        logfile = path.join(args.coverage_dir, "logs.txt")

        temp_dir = path.join(args.coverage_dir, "nyc_output")

        cmd: list[str] = [
            "npx", "nyc",
            "--all",
            "--clean",
            "--exclude", "**",
            "--include", "node_modules",
            "--temp_dir", temp_dir,
            "--reporter", "lcov",
            "--report-dir", args.coverage_dir,
            "cargo", "run", "--release", "--bin", "railcar", "--",
            "--mode", conf.mode,
            "--port", str(port),
            "--outdir", path.dirname(args.run_config_path),
            "--config", conf.config_file,
            "--seed", str(conf.seed),
            "--replay",
        ]

        if conf.schema is not None:
            cmd += ["--schema", conf.schema]

        if args.cores is not None:
            cmd += ["--cores", ",".join(map(str, args.cores))]

        cmd += [conf.entrypoint]

        makedirs(args.coverage_dir, exist_ok=False)
        with open(logfile, "a") as f:
            sp.run(cmd, stderr=sp.STDOUT, stdout=f)


    def run(self, args: RunArgs):
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

        if args.schema is not None:
            cmd += ["--schema", args.schema]

        if args.cores is not None:
            cores = ",".join(map(str, args.cores))
            cmd += ["--cores", cores]

        cmd += [args.entrypoint]

        makedirs(args.outdir, exist_ok=False)
        with open(logfile, "a") as f:
            sp.run(cmd, stderr=sp.STDOUT, stdout=f)
