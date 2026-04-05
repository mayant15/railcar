#!/usr/bin/env python3

import json
import argparse
import os
import subprocess
import traceback
from railcar import Railcar
from base import Config


def load_manifest_entry(manifest_path: str, index: int):
    with open(manifest_path, "r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i == index:
                return json.loads(line)
    raise IndexError(f"Manifest index {index} out of range")


def debug_environment(entry, run_args):
    print("\n===== DEBUG: BASIC INFO =====")
    print("PID:", os.getpid())
    print("SLURM_CPUS_PER_TASK:", os.environ.get("SLURM_CPUS_PER_TASK"))

    print("\n===== DEBUG: CPU VISIBILITY =====")
    print("os.cpu_count():", os.cpu_count())
    subprocess.run(["nproc"])
    subprocess.run(["taskset", "-pc", str(os.getpid())])
    subprocess.run(["bash", "-c", "grep Cpus_allowed_list /proc/self/status"])

    print("\n===== DEBUG: RUN ARGS =====")
    print(run_args)

    print("\n===== DEBUG: MANIFEST ENTRY =====")
    for k, v in entry.items():
        print(f"{k}: {v}")

    print("\n===== DEBUG: CONFIG FILE =====")
    config_path = entry.get("config_file_path")
    print("config_file_path:", config_path)

    if config_path and os.path.exists(config_path):
        print("---- config file contents ----")
        try:
            with open(config_path, "r") as f:
                print(f.read())
        except Exception as e:
            print("Failed to read config file:", e)
        print("---- end config ----")
    else:
        print("No config file found or path invalid")

    print("\n===== DEBUG: ENV (filtered) =====")
    for k in sorted(os.environ):
        if "SLURM" in k or "CPU" in k or "CORE" in k:
            print(f"{k}={os.environ[k]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--index", type=int, required=True)
    args = parser.parse_args()

    entry = load_manifest_entry(args.manifest, args.index)
    allowed_cores = sorted(os.sched_getaffinity(0))
    print("===== DEBUG: allowed_cores =====", allowed_cores, flush=True)
    print("is it even coming here")
    tool = Railcar()
    print("sfter tool = railcar")

    run_args = Railcar.RunArgs(
        timeout=entry["timeout"],
        outdir=entry["outdir"],
        seed=entry["seed"],
        mode=entry["mode"],
        schema=entry["schema"],
        entrypoint=entry["entrypoint"],
        config_file_path=entry["config_file_path"],
        labels=entry["labels"],
 cores=allowed_cores,
    )

    config = Config(tool, run_args)

    print("Running job:", entry["manifest_index"])
    print(entry["project"], entry["mode"], entry["schema_type"], entry["seed"])

    # 🔍 DEBUG BEFORE RUN
    debug_environment(entry, run_args)

    print("\n===== DEBUG: STARTING config.run() =====")

    try:
        config.run()
        print("\n===== DEBUG: config.run() FINISHED =====")
    except Exception as e:
        print("\n===== DEBUG: config.run() CRASHED =====")
        traceback.print_exc()


if __name__ == "__main__":
    main()
