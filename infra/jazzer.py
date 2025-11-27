from typing import Optional
from dataclasses import dataclass
from argparse import ArgumentParser
from base import Config, Tool
from multiprocessing import Pool
from random import randint
from os import path, listdir

import subprocess as sp

import os
import util


class Jazzer(Tool):

    @dataclass
    class RunArgs:
        outdir: str
        entrypoint: str
        core: Optional[int] = None
        seed: Optional[int] = None
        timeout: Optional[int] = None

    def move_crashes(self, destdir: str):
        for file in listdir(os.getcwd()):
            if file.startswith("crash-"):
                os.rename(file, path.join(destdir, path.basename(file)))

    def run(self, args: RunArgs) -> str:
        corpus = path.join(args.outdir, "corpus")
        crashes = path.join(args.outdir, "crashes")
        logfile = path.join(args.outdir, "logs.txt")

        os.makedirs(corpus, exist_ok=False)
        os.makedirs(crashes, exist_ok=False)

        cmd = []

        if args.core is not None:
            cmd += ["taskset", "-a", "--cpu-list", str(args.core)]

        cmd += ["npx", "jazzer", args.entrypoint, corpus, "--", "-fork=1", "-ignore_crashes=1"]

        if args.seed is not None:
            cmd += [f"-seed={str(args.seed)}"]

        if args.timeout is not None:
            cmd += [f"-max_total_time={str(args.timeout)}"]

        olddir = os.getcwd()
        os.chdir(args.outdir)

        with open(logfile, "a") as f:
            sp.run(cmd, stderr=sp.STDOUT, stdout=f)
        self.move_crashes(crashes)

        os.chdir(olddir)


def find_jazzer_entrypoint(project: str) -> list[str]:
    base = path.join(util.get_examples_dir(), project)

    # if there's a jazzer/ directory, look into it for fuzz drivers
    drivers_dir = path.join(base, "jazzer")
    if path.exists(drivers_dir):
        return [path.join(drivers_dir, driver) for driver in listdir(drivers_dir)]

    # if there's a jazzer.js, assume there's only one fuzz driver
    jazzer = path.join(base, "jazzer.js")
    if path.exists(jazzer):
        return [jazzer]

    # unreachable
    assert False


def generate_configs(
    projects: list[str],
    seeds: list[int],
    iterations: int,
    results_dir: str,
    timeout: Optional[int],
    pin: bool,
) -> list[Config]:
    tool = Jazzer()
    configs: list[Config] = []
    core_count = os.cpu_count()

    for project in projects:
        # TODO: run multiple entrypoints in parallel
        entrypoint = find_jazzer_entrypoint(project)[0]

        for i in range(iterations):
            core = len(configs) % core_count if pin else None
            outdir = path.join(results_dir, f"{project}_{i}")
            configs.append(Config(tool, Jazzer.RunArgs(
                timeout=timeout,
                outdir=outdir,
                seed=seeds[i],
                core=core,
                entrypoint=entrypoint,
            )))

    return configs


def execute_config(config: Config):
    config.run()


def arguments():
    parser = ArgumentParser()
    parser.add_argument(
            "--timeout", type=int, help="timeout in minutes")
    parser.add_argument(
            "--iterations", type=int, default=1,
            help="number of parallel iterations")
    parser.add_argument("-p", "--pin", action="store_true", default=True,
                        help="pin fuzzer processes to a core")
    args = parser.parse_args()

    # minutes to seconds
    args.timeout = args.timeout * 60 if args.timeout is not None else None

    return args


def main() -> None:
    args = arguments()

    projects = util.discover_projects()
    results_dir = util.ensure_results_dir("jazzer")

    seeds = [randint(0, 100000) for i in range(args.iterations)]

    # run these configs in parallel
    configs = generate_configs(
        projects=projects,
        iterations=args.iterations,
        results_dir=results_dir,
        seeds=seeds,
        timeout=args.timeout,
        pin=args.pin
    )

    pool_size = len(projects) * args.iterations
    assert pool_size == len(configs)

    pool = Pool(pool_size)
    pool.map(execute_config, configs)
    pool.close()
    pool.terminate()


if __name__ == '__main__':
    main()
