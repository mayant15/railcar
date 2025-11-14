# Runs Railcar on all projects in the examples directory without a timeout.
# Meant for background, long-running experiments.

from railcar import Railcar
from base import Config
from random import randint
from multiprocessing import Pool
from os import path, makedirs

import util


def write_project_info(project: str, outdir: str):
    makedirs(outdir, exist_ok=True)
    with open(path.join(outdir, "project"), "w") as f:
        f.write(project)


def generate_configs(
    projects: list[str],
    seed: int,
    base_outdir: str
) -> list[Config]:
    railcar = Railcar()
    configs = []

    for project in projects:
        outdir = path.join(base_outdir, project)

        config = util.get_default_project_config_file(project)
        assert config is not None

        write_project_info(project, outdir)

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

    projects = util.discover_projects()

    configs = generate_configs(projects, seed, outdir)

    pool = Pool(len(projects))
    pool.map(execute, configs)

    pool.close()
    pool.terminate()


if __name__ == "__main__":
    main()
