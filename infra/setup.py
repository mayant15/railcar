from glob import glob
from os import path

import subprocess as sp
import os


def setup_project(base_dir: str):
    old_dir = os.getcwd()
    os.chdir(base_dir)

    os.environ["SRC"] = "src"
    sp.run(["bash", path.join(base_dir, "setup.sh")])

    os.chdir(old_dir)


def main():
    projects_dir = path.join(path.dirname(path.realpath(__file__)), "projects")
    for dir in glob(f"{projects_dir}/*"):
        if path.isdir(dir):
            print("[*] setting up", path.basename(dir))
            setup_project(dir)


if __name__ == "__main__":
    main()
