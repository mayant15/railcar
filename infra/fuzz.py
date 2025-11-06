from argparse import ArgumentParser
from base import Config
from railcar import Railcar
from multiprocessing import Pool
from random import randint
from socket import gethostname
from os import path

import os
import util
import sqlite3
import requests
import subprocess as sp
import pandas as pd


def git_version():
    proc = sp.run([
        "git", "log", "--pretty=oneline", "-n", "1", "--no-decorate"
    ], capture_output=True, text=True)
    return proc.stdout.strip()


def find_entrypoints(project: str, mode: str) -> list[tuple[str, str]]:
    project_root_config_file = util.get_default_project_config_file(project)

    if mode != "bytes":
        assert project_root_config_file is not None

    if mode == "bytes":
        project_root = path.join(util.get_examples_dir(), project)
        return util.find_bytes_entrypoints(project_root)
    else:
        ep = util.find_graph_entrypoint(project)
        return [(ep, project_root_config_file)]


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

    for project in projects:
        for mode in modes:
            cs = []
            entrypoints = find_entrypoints(project, mode)
            for entrypoint, config_file in entrypoints:

                outdir_basename = f"{project}_{mode}"
                if mode == "bytes":
                    driver = path.basename(entrypoint).split('.')[0]
                    outdir_basename += f"_{driver}"

                for i in range(iterations):
                    outdir = path.join(
                        results_dir, f"iter_{i}", outdir_basename)
                    cs.append(Config(tool, Railcar.RunArgs(
                        timeout=timeout,
                        outdir=outdir,
                        seed=seeds[i],
                        mode=mode,
                        core=2*i,
                        entrypoint=entrypoint,
                        config_file_path=config_file,
                    )))
                configs.append(cs)

    return configs


def execute_config(config: Config):
    config.run()


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

        covered, total = row
        coverage_pct = covered * 100 / total
        project = config.args.project
        mode = config.args.mode
        iter = config.args.iteration

        results.append((iter, mode, project, covered, total, coverage_pct))

    return pd.DataFrame(results, columns=[
        "iteration", "mode", "project", "covered", "total", "coverage"
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

    projects = util.discover_projects()
    old_results_dir = util.get_old_results_dir()
    results_dir = util.ensure_results_dir()

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
