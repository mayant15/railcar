from scheduler import schedule, Job, Request
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


def generate_job_requests(
    projects: list[str],
    mode_schema_pairs: list[tuple[str, str]],
    seeds: list[int],
    iterations: int,
    results_dir: str,
    timeout: Optional[int] = None,
) -> list[Request[Config[Railcar.RunArgs]]]:
    tool = Railcar()
    metrics = path.join(results_dir, "metrics.db")

    reqs = []
    for mode, schema_type in mode_schema_pairs:
        for project in projects:
            entrypoints = [util.find_entrypoints(project, mode)[0]]

            schema = None
            if schema_type is not None:
                schema = util.find_schema(project, schema_type)
                assert schema is not None

            for entrypoint, config in entrypoints:
                driver = path.basename(entrypoint).split('.')[0]

                for i in range(iterations):
                    outdir = f"{project}_{mode}_{schema_type}_{driver}_{i}"
                    outdir = path.join(results_dir, outdir)

                    payload = Config(tool, Railcar.RunArgs(
                        timeout=timeout,
                        metrics=metrics,
                        outdir=outdir,
                        seed=seeds[i],
                        mode=mode,
                        schema=schema,
                        entrypoint=entrypoint,
                        config_file_path=config,
                        labels=[project, mode, schema_type, driver, i]
                    ))
                    reqs.append(Request(payload=payload, request=1, library=project))

    return reqs


def execute_job(job: Job[Config[Railcar.RunArgs]]):
    job.payload.args.cores = job.cores
    job.payload.run()


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
            "--timeout", default=1, type=int, help="timeout in minutes")
    parser.add_argument(
            "--iterations", type=int, default=1,
            help="number of parallel iterations")
    parser.add_argument("--mode", action='append',
                        choices=["bytes", "graph", "sequence"],
                        help="modes to run railcar in")
    args = parser.parse_args()

    # minutes to seconds
    args.timeout = args.timeout * 60

    # cannot use default here, argparse will always append a "sequence"
    args.mode = args.mode if args.mode is not None else ["sequence"]

    return args


def main() -> None:
    args = arguments()

    num_procs = 8  # os.process_cpu_count()
    projects = util.discover_projects()
    old_results_dir = util.get_old_results_dir()
    results_dir = util.ensure_results_dir()

    seeds = [randint(0, 100000) for i in range(args.iterations)]

    projects = [
        "fast-xml-parser",
        "tslib",
        "pako",
        "sharp",
        "redux",
        "jimp",
        "jpeg-js",
        "js-yaml",
    ]

    reqs = generate_job_requests(
        projects=projects,
        mode_schema_pairs=[
            ("sequence", None),
            ("sequence", "typescript"),
            ("bytes", None),
        ],
        iterations=args.iterations,
        results_dir=results_dir,
        seeds=seeds,
        timeout=args.timeout,
    )

    jobs = schedule(reqs, num_procs)
    print("Estimated time:", len(jobs) * args.timeout / (60 * 60), "hour(s)")
    for row in jobs:
        for job in row:
            job.cores[0] *= 2
        #     labels = job.payload.args.labels
        #     print(labels[0], labels[1], labels[2], job.cores, end=", ")
        # print("|")

    summary = generate_summary_prefix(args.timeout, seeds)

    for row in jobs:
        pool = Pool(num_procs)
        pool.map(execute_job, row, 1)
        pool.close()
        pool.terminate()

    # TODO: fix this to pick coverage data from main metrics.db
    coverage = collect_coverage([], results_dir)

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
