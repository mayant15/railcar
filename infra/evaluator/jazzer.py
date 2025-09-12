from evaluator.base import Project, Tool, run_with_nyc
from os.path import join, dirname, realpath
from dataclasses import dataclass
from time import perf_counter_ns

import subprocess as sp
import math
import os


RAILCAR_BASE = dirname(dirname(dirname(realpath(__file__))))
JAZZER_FUZZER = join(RAILCAR_BASE, "node_modules", "@jazzer.js", "fuzzer")


class Jazzer(Tool):

    @dataclass
    class Args:
        out_dir: str
        timeout: int
        seed: int
        core: int

    def config_str(self, name: str) -> str:
        return f"{name}_jazzer"

    def build(self):
        old_dir = os.getcwd()
        os.chdir(JAZZER_FUZZER)
        sp.run(["bun", "run", "build"])
        os.chdir(old_dir)

    def run(self, project: Project, args: Args):
        coverage_dir = join(args.out_dir, "coverage")
        crashes_dir = join(args.out_dir, "crashes")
        corpus_dir = join(args.out_dir, "corpus")
        logfile = join(args.out_dir, "logs.txt")

        os.makedirs(crashes_dir, exist_ok=False)
        os.makedirs(corpus_dir, exist_ok=False)

        time_remaining = float(args.timeout * 1000000)  # seconds to microseconds

        old_dir = os.getcwd()

        os.chdir(crashes_dir)

        cmd = [
            "taskset", "-a", "--cpu-list", str(args.core),
            "npx", "jazzer", project.jazzer_driver, corpus_dir,
            "--",
        ]

        seed = args.seed

        while time_remaining > 0:
            start = perf_counter_ns()
            try:
                remaining_seconds = math.ceil(time_remaining / 1000000)
                with open(logfile, "a") as f:
                    sp.run(
                        cmd + [
                            f"-seed={seed}",
                            f"-max_total_time={remaining_seconds}",
                        ],
                        stderr=sp.STDOUT,
                        stdout=f
                    )
            except Exception:
                pass
            end = perf_counter_ns()
            time_remaining -= (end - start) / 1000  # nanoseconds to microseconds
            seed += 1

        replay_cmd = [
            "jazzer", "--mode", "regression", project.jazzer_driver, corpus_dir
        ]

        run_with_nyc(
            project=project,
            coverage_dir=coverage_dir,
            working_dir=project.src,
            logfile=logfile,
            cmd=replay_cmd
        )

        os.chdir(old_dir)
        return coverage_dir
