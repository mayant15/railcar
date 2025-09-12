from typing import Optional
from dataclasses import dataclass
from evaluator.base import Tool, Project, run_with_nyc

import subprocess as sp
import socket
import os


def find_open_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Railcar(Tool):

    @dataclass
    class RunArgs:
        mode: str
        timeout: int
        out_dir: str
        seed: int
        core: int
        schema: Optional[str]
        simple: Optional[bool]

    def config_str(self, name: str) -> str:
        return f"{name}_railcar"

    def build(self):
        sp.run(["mise", "build"])

    def run(self, project: Project, args: RunArgs) -> str:
        coverage_dir = os.path.join(args.out_dir, "coverage")
        crashes_dir = os.path.join(args.out_dir, "crashes")
        corpus_dir = os.path.join(args.out_dir, "corpus")
        logfile = os.path.join(args.out_dir, "logs.txt")

        port = find_open_port()

        os.makedirs(coverage_dir, exist_ok=True)
        os.makedirs(crashes_dir, exist_ok=True)
        os.makedirs(corpus_dir, exist_ok=True)

        schema = None
        if args.mode != "bytes":
            if args.schema == "typescript":
                schema = os.path.join(args.out_dir, "schema.json")
                infer_schema(project.types, schema)

        metrics = os.path.join(args.out_dir, "metrics.json")

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
        ]

        if project.ignored is not None:
            for ign in project.ignored:
                cmd += ["-i", ign]

        if project.skip_endpoints is not None:
            for ign in project.skip_endpoints:
                cmd += ["-s", ign]

        if args.simple:
            cmd += ['--simple-mutations']

        if schema is not None:
            cmd += ["--schema", schema]

        entrypoint = project.driver if args.mode == "bytes" else project.library_main
        cmd += [entrypoint]

        with open(logfile, "a") as f:
            sp.run(cmd, stderr=sp.STDOUT, stdout=f)

        coverage_cmd = [
            "cargo", "run",
            "--release",
            "--bin", "railcar",
            "--",
            "--replay",
            "--corpus", corpus_dir,
            "--crashes", crashes_dir,
            "--mode", args.mode,
            "--seed", str(args.seed),
            "--port", str(port),
        ]

        if project.ignored is not None:
            for ign in project.ignored:
                coverage_cmd += ["-i", ign]

        if project.skip_endpoints is not None:
            for ign in project.skip_endpoints:
                coverage_cmd += ["-s", ign]

        if schema is not None:
            coverage_cmd += ["--schema", schema]

        coverage_cmd += [entrypoint]

        run_with_nyc(
            project=project,
            coverage_dir=coverage_dir,
            working_dir=args.out_dir,
            cmd=coverage_cmd,
            logfile=logfile,
        )

        return coverage_dir


def infer_schema(types: str, out: str):
    sp.run([
        "npx", "railcar-infer",
        "--decl", types,
        "-o", out
    ])
