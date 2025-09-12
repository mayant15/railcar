from typing import Optional
from abc import ABC, abstractmethod
from dataclasses import dataclass
from os.path import join, dirname, realpath
from shutil import rmtree

import subprocess as sp
import json
import os


RAILCAR_BASE = dirname(dirname(dirname(realpath(__file__))))
PROJECT_BASE = join(RAILCAR_BASE, "benchmarks", "projects")


class Project:
    def __init__(
        self,
        name: str,
        include: str,
        library_main: str = "index.js",
        exclude: Optional[str] = None,
        ignored: Optional[list[str]] = None,
        skip_endpoints: Optional[list[str]] = None,
        unit_test_cmd: Optional[list[str]] = None,
    ):
        self.name = name
        self.types = join(PROJECT_BASE, name, "index.d.ts")
        self.driver = join(PROJECT_BASE, name, "drivers", "baseline.js")
        self.jazzer_driver = join(PROJECT_BASE, name, "drivers", "jazzer.js")
        self.src = join(PROJECT_BASE, name, "src")
        self.include = include
        self.exclude = exclude
        self.library_main = join(self.src, library_main)
        self.ignored = ignored
        self.skip_endpoints = skip_endpoints
        self.unit_test_cmd = unit_test_cmd


class Tool(ABC):
    def __init__(self):
        pass

    @abstractmethod
    def build(self):
        raise NotImplementedError

    @abstractmethod
    def run(self, project: Project, args) -> str:
        pass

    @abstractmethod
    def config_str(self, project_name: str) -> str:
        pass


@dataclass
class Config:
    tool: Tool
    project: Project
    args: object

    def run(self):
        coverage_dir = self.tool.run(self.project, self.args)
        try:
            _extract_coverage_summary(coverage_dir)
        except ValueError:
            print(f"failed to extract coverage for {coverage_dir}")

    def name(self) -> str:
        return self.tool.config_str(self.project.name)


def _extract(file, term):
    proc = sp.run(
        f"cat {file} | rg {term} -B 1 | rg -o '([0-9\\.]+)\\%' -r '$1'",
        shell=True, capture_output=True, text=True
    )
    return proc.stdout.strip()


def _extract_coverage_summary(coverage_dir: str):
    html = join(coverage_dir, "lcov-report", "index.html")

    coverage = {}
    coverage["line"] = float(_extract(html, "Lines"))
    coverage["branch"] = float(_extract(html, "Branches"))

    outfile = join(coverage_dir, "coverage.json")
    with open(outfile, "w") as f:
        f.write(json.dumps(coverage, indent=2))


def run_with_nyc(
        project: Project,
        coverage_dir: str,
        working_dir: str,
        logfile: str,
        cmd: list[str]
):
    nyc_cwd = project.src
    nyc_temp_dir = join(coverage_dir, ".nyc_output")

    rmtree(coverage_dir, ignore_errors=True)
    os.makedirs(coverage_dir)

    old_dir = os.getcwd()
    os.chdir(working_dir)

    wrapped_cmd = [
        "npx", "nyc",
        "--all",
        "--clean",
        "--cwd", nyc_cwd,
        "--temp-dir", nyc_temp_dir,
        "--reporter", "lcov",
        "--report-dir", coverage_dir,
        "--include", project.include
    ]

    if project.exclude is not None:
        wrapped_cmd += ["--exclude", project.exclude]

    wrapped_cmd += cmd

    with open(logfile, "a") as f:
        sp.run(wrapped_cmd, stderr=sp.STDOUT, stdout=f)

    rmtree(nyc_temp_dir, ignore_errors=True)

    os.chdir(old_dir)
