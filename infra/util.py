from typing import Optional
from datetime import datetime
from shutil import rmtree
from os import path, makedirs, getcwd, listdir

import subprocess as sp


RAILCAR_ROOT = path.dirname(path.dirname(path.realpath(__file__)))
EXAMPLES_DIR = path.join(RAILCAR_ROOT, "examples")


def ensure_results_dir() -> str:
    timestamp = datetime.now().strftime("%Y-%m-%d-%s")
    dir = path.join(getcwd(), f"railcar-results-{timestamp}")

    if path.exists(dir):
        rmtree(dir)
    makedirs(dir, exist_ok=False)

    return dir


def get_old_results_dir() -> str | None:
    dirs = listdir()
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


def discover_projects() -> list[str]:
    dirs = filter(
        lambda dir: path.isdir(path.join(EXAMPLES_DIR, dir))
        and dir != "example",
        listdir(EXAMPLES_DIR),
    )
    return list(dirs)


def get_railcar_root() -> str:
    return RAILCAR_ROOT


def get_examples_dir() -> str:
    return EXAMPLES_DIR


def find_graph_entrypoint(project: str) -> str:
    if project == "turf":
        project = "@turf/turf"
    elif project == "angular":
        project = "@angular/compiler"
    elif project == "xmldom":
        project = "@xmldom/xmldom"

    # find the path to npm package entry point in node_modules
    locator = path.join(get_examples_dir(), "locate-index.js")
    index = sp.run(
        ["node", locator, project],
        capture_output=True,
        text=True
    )
    return index.stdout.strip()


def find_bytes_entrypoints(project_root: str) -> list[tuple[str, str]]:
    project_root_config_file = path.join(project_root, "railcar.config.js")

    # if there's a railcar/ directory, look into it for fuzz drivers
    drivers_dir = path.join(project_root, "railcar")
    if path.exists(drivers_dir):
        drivers = []

        for dir in listdir(drivers_dir):
            if 'config' in dir:
                continue

            driver = path.join(drivers_dir, dir)
            name = path.basename(dir).split('.')[0]

            # if there's a {name}.config.js, use that. Otherwise use the project
            # root's config file
            adjacent_config_file = path.join(drivers_dir, f"{name}.config.js")
            if path.exists(adjacent_config_file):
                drivers.append([driver, adjacent_config_file])
            elif path.exists(project_root_config_file):
                drivers.append((driver, project_root_config_file))
            else:
                raise FileNotFoundError(f"failed to find configuration file for driver {driver}")

        assert len(drivers) != 0
        return drivers

    # if there's a baseline.js, assume there's only one fuzz driver
    baseline = path.join(project_root, "baseline.js")
    if path.exists(baseline):
        assert path.exists(project_root_config_file)
        return [(baseline, project_root_config_file)]

    # unreachable
    assert False


def get_default_project_config_file(project: str) -> Optional[str]:
    project_root = path.join(get_examples_dir(), project)
    project_root_config_file = path.join(project_root, "railcar.config.js")
    if path.exists(project_root_config_file):
        return project_root_config_file
    else:
        return None
