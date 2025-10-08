from argparse import ArgumentParser
from base import Config
from railcar import Railcar
from multiprocessing import Pool
from random import randint
from socket import gethostname
from datetime import datetime
from shutil import rmtree
from os import path

import os
import sqlite3
import requests
import subprocess as sp
import pandas as pd


RAILCAR_ROOT = path.dirname(path.dirname(path.realpath(__file__)))
EXAMPLES_DIR = path.join(RAILCAR_ROOT, "examples")


def git_version():
    proc = sp.run([
        "git", "log", "--pretty=oneline", "-n", "1", "--no-decorate"
    ], capture_output=True, text=True)
    return proc.stdout.strip()


def find_entrypoints(project: str, mode: str) -> list[str]:
    if mode == "bytes":
        baseline = path.join(EXAMPLES_DIR, project, "baseline.js")
        if path.exists(baseline):
            return [baseline]

        # collect all Railcar drivers
        drivers = []
        drivers_dir = path.join(EXAMPLES_DIR, project, "railcar")
        for dir in os.listdir(drivers_dir):
            drivers.append(path.join(EXAMPLES_DIR, project, "railcar", dir))
        return drivers

    else:
        # find the path to npm package entry point in node_modules
        locator = path.join(EXAMPLES_DIR, "locate-index.js")
        index = sp.run(
            ["node", locator, project],
            capture_output=True,
            text=True
        )
        return [index.stdout]


def generate_configs(
    projects: list[str],
    modes: list[str],
    seeds: list[int],
    iterations: int,
    results_dir: str,
    timeout: int,
) -> list[list[Config]]:
    tool = Railcar()
    configs: list[list[Config]] = []
    examples_dir = path.join(RAILCAR_ROOT, "examples")

    for project in projects:
        config_file = path.join(examples_dir, project, "railcar.config.js")
        for mode in modes:
            cs = []
            entrypoints = find_entrypoints(project, mode)
            for entrypoint in entrypoints:
                for i in range(iterations):
                    outdir = path.join(
                        results_dir, f"iter_{i}", f"{project}_{mode}")
                    cs.append(Config(tool, Railcar.RunArgs(
                        timeout=timeout,
                        outdir=outdir,
                        seed=seeds[i],
                        mode=mode,
                        core=2*i,
                        entrypoint=entrypoint,
                        config_file_path=config_file,
                        project=project,
                        iteration=i
                    )))
                configs.append(cs)

    return configs


def execute_config(config: Config):
    config.run()


def get_old_results_dir() -> str | None:
    dirs = os.listdir()
    latest = None
    for dir in dirs:
        if dir.startswith("railcar-results-"):
            mod = path.getmtime(dir)
            if latest is None:
                latest = dir
            else:
                old_mod = path.getmtime(latest)
                if mod > old_mod:
                    latest = dir
    return latest


def ensure_results_dir() -> str:
    timestamp = datetime.now().strftime("%Y-%m-%d-%s")
    dir = path.join(os.getcwd(), f"railcar-results-{timestamp}")

    if path.exists(dir):
        rmtree(dir)
    os.makedirs(dir, exist_ok=False)

    return dir


def generate_summary_prefix(timeout, seeds) -> str:
    summary = ""
    summary += "{}\n".format(git_version())
    summary += "Ran on {}\n".format(gethostname())
    summary += "Timeout: {} seconds\n".format(timeout)
    summary += "\n"

    for i in range(len(seeds)):
        summary += "iter_{} seed: {}\n".format(i, seeds[i])

    return summary


def collect_coverage(configs: list[Config], results: str) -> str:
    configs = [x for cs in configs for x in cs]
    results = []
    for config in configs:
        db = path.join(config.args.outdir, "metrics.db")
        conn = sqlite3.connect(db)
        cur = conn.cursor()
        row = cur.execute("""
            select coverage, total_edges from heartbeat
            where timestamp in (select max(timestamp) from heartbeat)
            """).fetchone()

        if row is None:
            print("config failed:", config)
            continue

        coverage_pct = row[0] * 100 / row[1]
        project = config.args.project
        mode = config.args.mode
        iter = config.args.iteration

        results.append((iter, mode, project, coverage_pct))

    return pd.DataFrame(results, columns=[
        "iteration", "mode", "project", "coverage"
    ])


def post_summary_notification(summary: str):
    url = os.environ["DISCORD_WEBHOOK"]
    summary = f"```\n{summary}\n```"
    requests.post(url, json={"content": summary})


def summarize_coverage(
    coverage: pd.DataFrame,
    old_coverage: pd.DataFrame | None
) -> str:
    new_coverage = coverage.groupby(['project', 'mode']).mean()[['coverage']]
    if old_coverage is not None:
        old_coverage = old_coverage.groupby(['project', 'mode']).mean()[['coverage']]
        new_coverage['change'] = new_coverage['coverage'] - old_coverage['coverage']
        new_coverage['change'] = new_coverage['change'] * 100 / old_coverage['coverage']
        new_coverage = new_coverage.sort_values(by='change', ascending=False)

    return new_coverage.to_string(
        float_format=lambda f: "{:.2f}%".format(f)
    )


def discover_projects() -> list[str]:
    dirs = filter(
        lambda dir: os.path.isdir(os.path.join(EXAMPLES_DIR, dir))
        and dir != "example",
        os.listdir(EXAMPLES_DIR),
    )
    return list(dirs)


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument(
            "--timeout", type=int, default=1, help="timeout in minutes")
    parser.add_argument(
            "--iterations", type=int, default=4,
            help="number of parallel iterations")
    args = parser.parse_args()

    timeout = args.timeout * 60
    iterations = args.iterations
    drivers = ["bytes", "graph"]

    projects = discover_projects()
    old_results_dir = get_old_results_dir()
    results_dir = ensure_results_dir()

    seeds = [randint(0, 100000) for i in range(iterations)]

    # list of list of configs
    # run outer list serially, inner list in parallel
    configs = generate_configs(
        projects=projects,
        modes=drivers,
        iterations=iterations,
        results_dir=results_dir,
        seeds=seeds,
        timeout=timeout,
    )

    summary = generate_summary_prefix(timeout, seeds)

    processes_pool = iterations
    for cs in configs:
        with Pool(processes_pool) as pool:
            pool.map(execute_config, cs)

    coverage = collect_coverage(configs, results_dir)

    old_coverage = None
    if old_results_dir is not None:
        old_coverage_path = path.join(old_results_dir, "coverage.csv")
        old_coverage = pd.read_csv(old_coverage_path)
    summary += summarize_coverage(coverage, old_coverage)
    summary += "\n"

    # Write summary file
    with open(path.join(results_dir, "summary.txt"), "w") as f:
        f.write(summary)

    with open(path.join(results_dir, "coverage.csv"), "w") as f:
        f.write(coverage.to_csv())

    if "DISCORD_WEBHOOK" in os.environ:
        post_summary_notification(summary)


if __name__ == '__main__':
    main()
