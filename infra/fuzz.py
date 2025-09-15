from base import Config
from railcar import Railcar
from multiprocessing import Pool
from random import randint
from socket import gethostname
from datetime import datetime
from shutil import rmtree
from os import path

import os
import subprocess as sp


RAILCAR_ROOT = path.dirname(path.dirname(path.realpath(__file__)))
EXAMPLES_DIR = path.join(RAILCAR_ROOT, "examples")


def git_version():
    proc = sp.run([
        "git", "log", "--pretty=oneline", "-n", "1", "--no-decorate"
    ], capture_output=True, text=True)
    return proc.stdout.strip()


def find_entrypoint(project: str, driver: str) -> str:
    if driver == "bytes":
        return path.join(EXAMPLES_DIR, project, "baseline.js")
    else:
        # find the path to npm package entry point in node_modules
        locator = path.join(EXAMPLES_DIR, "locate-index.js")
        index = sp.run(
            ["node", locator, project],
            capture_output=True,
            text=True
        )
        return index.stdout


def generate_configs(
    projects: list[str],
    drivers: list[str],
    seeds: list[int],
    iterations: int,
    results_dir: str,
    timeout: int,
) -> list[list[Config]]:
    tool = Railcar()
    configs: list[list[Config]] = []
    examples_dir = path.join(RAILCAR_ROOT, "examples")

    for project in projects:
        config_file = path.join(examples_dir, project, "railcar.toml")
        for driver in drivers:
            cs = []
            entrypoint = find_entrypoint(project, driver)
            for i in range(iterations):
                outdir = path.join(
                    results_dir, f"iter_{i}", f"{project}_{driver}")
                cs.append(Config(tool, Railcar.RunArgs(
                    timeout=timeout,
                    outdir=outdir,
                    seed=seeds[i],
                    mode=driver,
                    core=2*i,
                    entrypoint=entrypoint,
                    config_file_path=config_file
                )))
            configs.append(cs)

    return configs


def execute_config(config: Config):
    config.run()


def ensure_results_dir() -> str:
    timestamp = datetime.now().strftime("%Y-%m-%d-%s")
    dir = path.join(os.getcwd(), f"railcar-results-{timestamp}")

    if path.exists(dir):
        rmtree(dir)
    os.makedirs(dir, exist_ok=False)

    return dir


def generate_summary(timeout, seeds) -> str:
    summary = ""
    summary += "{}\n".format(git_version())
    summary += "Ran on {}\n".format(gethostname())
    summary += "Timeout: {} seconds\n".format(timeout)
    summary += "\n"

    for i in range(len(seeds)):
        summary += "iter_{} seed: {}\n".format(i, seeds[i])

    return summary


def main() -> None:
    timeout: int = 20  # in seconds
    iterations: int = 6
    projects: list[str] = [
        "fast-xml-parser",
        # "pako",
        # "js-yaml",
        # "protobuf-js",
        # "sharp",
    ]
    drivers = ["bytes", "graph"]

    results_dir = ensure_results_dir()
    seeds = [randint(0, 100000) for i in range(iterations)]

    # list of list of configs
    # run outer list serially, inner list in parallel
    configs = generate_configs(
        projects=projects,
        drivers=drivers,
        iterations=iterations,
        results_dir=results_dir,
        seeds=seeds,
        timeout=timeout,
    )

    summary = generate_summary(timeout, seeds)

    processes_pool: int = iterations
    for cs in configs:
        with Pool(processes_pool) as pool:
            pool.map(execute_config, cs)

    # Write summary file
    with open(os.path.join(results_dir, "summary.txt"), "w") as f:
        f.write(summary)


if __name__ == '__main__':
    main()
