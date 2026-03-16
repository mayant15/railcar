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

                    schema_label = "none" if schema_type is None else schema_type
                    payload = Config(tool, Railcar.RunArgs(
                        timeout=timeout,
                        outdir=outdir,
                        seed=seeds[i],
                        mode=mode,
                        schema=schema,
                        entrypoint=entrypoint,
                        config_file_path=config,
                        labels=[project, mode, schema_label, driver, str(i)]
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


def arguments():
    parser = ArgumentParser()
    parser.add_argument(
            "--timeout", default=1, type=int, help="timeout in minutes")
    parser.add_argument(
            "--iterations", type=int, default=1,
            help="number of parallel iterations")
    parser.add_argument("--mode", action='append',
                        choices=["bytes", "sequence"],
                        help="modes to run railcar in")
    parser.add_argument("-n", "--dry-run", action="store_true", help="just print the execution plan and exit")
    args = parser.parse_args()

    # minutes to seconds
    args.timeout = args.timeout * 60

    # cannot use default here, argparse will always append a "sequence"
    args.mode = args.mode if args.mode is not None else ["sequence"]

    return args


def main() -> None:
    args = arguments()

    num_procs = os.process_cpu_count()
    projects = util.discover_projects()
    old_results_dir = util.get_old_results_dir()
    results_dir = util.ensure_results_dir(dry_run=args.dry_run)

    seeds = [randint(0, 100000) for i in range(args.iterations)]

    reqs = generate_job_requests(
        projects=projects,
        mode_schema_pairs=[
            ("sequence", "random"),
            ("sequence", "typescript"),
            ("sequence", "syntest"),
        ],
        iterations=args.iterations,
        results_dir=results_dir,
        seeds=seeds,
        timeout=args.timeout,
    )

    jobs = schedule(reqs, num_procs)
    print("Estimated time:", len(jobs) * args.timeout / (60 * 60), "hour(s)")

    if args.dry_run:
        for row in jobs:
            for job in row:
                labels = job.payload.args.labels
                assert labels is not None
                print(labels[0], labels[1], labels[2], job.cores, end=", ")
            print("|")
        return

    summary = generate_summary_prefix(args.timeout, seeds)

    for row in jobs:
        pool = Pool(num_procs)
        pool.map(execute_job, row, 1)
        pool.close()
        pool.terminate()

    # Write summary file
    with open(path.join(results_dir, "summary.txt"), "w") as f:
        f.write(summary)


if __name__ == '__main__':
    main()
