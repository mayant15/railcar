from evaluator.base import Tool, Project, run_with_nyc
from dataclasses import dataclass

import os


class UnitTest(Tool):

    @dataclass
    class Args:
        out_dir: str
        core: int

    def config_str(self, name: str) -> str:
        return f"{name}_testsuite"

    def build(self):
        pass

    def run(self, project: Project, args: Args) -> str:
        coverage_dir = os.path.join(args.out_dir, "coverage")
        logfile = os.path.join(args.out_dir, "logs.txt")

        if project.unit_test_cmd is None:
            return coverage_dir

        cmd = [
            "taskset", "-a", "--cpu-list", str(args.core),
        ] + project.unit_test_cmd

        run_with_nyc(
            project=project,
            coverage_dir=coverage_dir,
            working_dir=project.src,
            cmd=cmd,
            logfile=logfile
        )

        return coverage_dir
