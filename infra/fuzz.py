from typing import Optional
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


def generate_configs(
    projects: list[str],
    modes: list[str],
    seeds: list[int],
    iterations: int,
    results_dir: str,
    timeout: Optional[int] = None,
    core_count: int = os.cpu_count(),
) -> list[list[Config]]:
    tool = Railcar()
    metrics = path.join(results_dir, "metrics.db")

    assert iterations <= core_count
    max_parallel_projects = core_count // iterations

    all_configs = []

    for mode in modes:
        mode_configs = []
        for project_idx, project in enumerate(projects):
            row = project_idx // max_parallel_projects
            col = project_idx % max_parallel_projects
            core_base = iterations * col

            if row >= len(mode_configs):
                mode_configs.append([])
            assert len(mode_configs[row]) == core_base

            # TODO: Just running the first entrypoint. Eventually I would like
            # railcar to be able to run multiple entrypoints in parallel
            entrypoint, config_file = util.find_entrypoints(project, mode)[0]

            outdir_basename = f"{project}_{mode}"
            if mode == "bytes":
                driver = path.basename(entrypoint).split('.')[0]
                outdir_basename += f"_{driver}"

            for i in range(iterations):
                core = core_base + i
                outdir = path.join(results_dir, f"{outdir_basename}_{i}")
                mode_configs[row].append(Config(tool, Railcar.RunArgs(
                    timeout=timeout,
                    metrics=metrics,
                    outdir=outdir,
                    seed=seeds[i],
                    mode=mode,
                    core=core,
                    entrypoint=entrypoint,
                    config_file_path=config_file,
                    labels=[project, i, mode]
                )))
        all_configs += mode_configs

    return all_configs


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


def collect_coverage(configs: list[Config], results_dir: str) -> str:
    configs = [x for cs in configs for x in cs]
    results = []
    db = path.join(results_dir, "metrics.db")
    conn = sqlite3.connect(db)
    for config in configs:
        cur = conn.cursor()
        row = cur.execute("""
            select coverage, total_edges, valid_execs, execs from heartbeat
            where timestamp in (select max(timestamp) from heartbeat)
            """).fetchone()

        if row is None:
            print("config failed:", config)
            continue

        covered, total, valid_execs, execs = row
        coverage_pct = covered * 100 / total
        project = config.args.labels[0]
        mode = config.args.mode
        iter = config.args.labels[1]

        results.append((iter, mode, project, covered, total, coverage_pct, valid_execs, execs))

    return pd.DataFrame(results, columns=[
        "iteration", "mode", "project", "covered", "total", "coverage", "valid_execs", "execs"
    ])


def post_summary_notification(summary: str):
    url = os.environ["DISCORD_WEBHOOK"]
    summary = f"```\n{summary}\n```"
    requests.post(url, json={"content": summary})


def summarize_coverage(
    coverage: pd.DataFrame,
    old: pd.DataFrame | None
) -> str:
    new = coverage.groupby(['project', 'mode']).mean()[['coverage', "valid_execs", "execs"]]
    if old is not None:
        old = old.groupby(['project', 'mode']).mean()[['coverage', 'valid_execs', 'execs']]

        new['change'] = new['coverage'] - old['coverage']
        new['change'] = new['change'] * 100 / old['coverage']

        new['change_valid_execs'] = new['valid_execs'] - old['valid_execs']
        new['change_valid_execs'] = new['change_valid_execs'] * 100 / old['valid_execs']

        new['change_execs'] = new['execs'] - old['execs']
        new['change_execs'] = new['change_execs'] * 100 / old['execs']

        new = new.sort_values(by='change', ascending=False)

    return new.to_string(
        float_format=lambda f: "{:.2f}%".format(f)
    )


def arguments():
    parser = ArgumentParser()
    parser.add_argument(
            "--timeout", type=int, help="timeout in minutes")
    parser.add_argument(
            "--iterations", type=int, default=1,
            help="number of parallel iterations")
    parser.add_argument("--mode", action='append',
                        choices=["bytes", "graph", "parametric", "sequence"],
                        help="modes to run railcar in")
    args = parser.parse_args()

    # minutes to seconds
    args.timeout = args.timeout * 60 if args.timeout is not None else None
    args.mode = args.mode if args.mode is not None else ["graph"]

    return args


def main() -> None:
    args = arguments()

    projects = util.discover_projects()
    old_results_dir = util.get_old_results_dir()
    results_dir = util.ensure_results_dir()

    seeds = [randint(0, 100000) for i in range(args.iterations)]

    # list of list of configs
    # run outer list serially, inner list in parallel
    configs = generate_configs(
        projects=projects,
        modes=args.mode,
        iterations=args.iterations,
        results_dir=results_dir,
        seeds=seeds,
        timeout=args.timeout,
        core_count=os.process_cpu_count(),
    )

    if args.timeout is None:
        for config in configs:
            pool = Pool()
            pool.map(execute_config, config, 1)
            pool.close()
            pool.terminate()
    else:
        summary = generate_summary_prefix(args.timeout, seeds)

        for config in configs:
            pool = Pool()
            pool.map(execute_config, config, 1)
            pool.close()
            pool.terminate()

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
