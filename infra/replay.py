from scheduler import schedule, Job, Request
from base import Config
from railcar import Railcar

from os import path
from random import randint
from typing import Optional
from argparse import ArgumentParser
from multiprocessing import Pool

import util
import glob
import os


def generate_job_requests(base_coverage_dir: str, configs: list[str]) -> list[Request[Config[Railcar.CoverageArgs]]]:
    tool = Railcar()
    reqs: list[Request[Config[Railcar.CoverageArgs]]] = []

    for run_config_path in configs:
        coverage_dir_suffix = path.basename(path.dirname(run_config_path))
        coverage_dir = path.join(base_coverage_dir, coverage_dir_suffix)
        payload = Config(tool, Railcar.CoverageArgs(
            run_config_path=run_config_path,
            coverage_dir=coverage_dir,
        ))

        # the scheduler does not use `library` right now, pass empty string
        reqs.append(Request(payload=payload, request=1, library=""))

    return reqs


def arguments():
    parser = ArgumentParser()
    parser.add_argument("outdir", help="output directory from a previous run")

    return parser.parse_args()


def collect_run_configs(basedir: str) -> list[str]:
    """
    Walk `basedir` and finds `fuzzer-config.json` files from previous runs.
    """
    configs = glob.iglob("**/fuzzer-config.json", root_dir=basedir, recursive=True)

    dirs = []
    for config in configs:
        dirs.append(path.join(basedir, config))

    return dirs


def execute_job(job: Job[Config[Railcar.CoverageArgs]]):
    job.payload.args.cores = job.cores
    job.payload.coverage()


def main():
    args = arguments()

    num_procs = os.process_cpu_count()
    base_coverage_dir = util.ensure_results_dir("railcar-replay-coverage")

    configs = collect_run_configs(args.outdir)

    reqs = generate_job_requests(base_coverage_dir, configs)
    jobs = schedule(reqs, num_procs)
    for row in jobs:
        for job in row:
            label = path.basename(job.payload.args.coverage_dir)
    #         print(label, job.cores, end=", ")
    #     print("|")
    # assert False

    for row in jobs:
        pool = Pool(num_procs)
        pool.map(execute_job, row, 1)
        pool.close()
        pool.terminate()

if __name__ == "__main__":
    main()
