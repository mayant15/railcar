# Runs Railcar on all projects in the examples directory without a timeout.
# Meant for background, long-running experiments.

from railcar import Railcar
from base import Config
from random import randint
from multiprocessing import Pool
from os import path

import util
import time


def generate_configs(
    projects: list[str],
    seed: int,
    base_outdir: str
) -> list[Config]:
    railcar = Railcar()
    configs = []

    for project in projects:
        outdir = path.join(base_outdir, project)

        print(project)

        config = util.get_default_project_config_file(project)
        assert config is not None

        config = Config(tool=railcar, args=Railcar.RunArgs(
            seed=seed,
            mode="graph",
            outdir=outdir,
            entrypoint=util.find_graph_entrypoint(project),
            config_file_path=config,
        ))
        configs.append(config)

    return configs


def execute(config: Config):
    config.run()


def main():
    outdir = util.ensure_results_dir()
    seed = randint(0, 100000)

    # projects = util.discover_projects()
    projects = ["fast-xml-parser", "pako"]

    configs = generate_configs(projects, seed, outdir)
    print(configs)

    pool = Pool(len(projects))
    pool.map(execute, configs)

    pool.close()
    pool.terminate()


if __name__ == "__main__":
    main()
