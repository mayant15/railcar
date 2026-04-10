#!/usr/bin/env python3

from argparse import ArgumentParser
from os import path
from random import randint
import json

import util


def arguments():
    parser = ArgumentParser()
    parser.add_argument("--timeout", default=1, type=int, help="timeout in minutes")
    parser.add_argument("--iterations", type=int, default=1,
                        help="number of iterations per configuration")
    parser.add_argument("--mode", action="append",
                        choices=["bytes", "sequence"],
                        help="modes to run railcar in")
    parser.add_argument("--results-dir", default=None,
                        help="results directory to use; if omitted, create one")
    parser.add_argument("--output", default="jobs.jsonl",
                        help="manifest output path")
    parser.add_argument("--dry-run", action="store_true",
                        help="print summary only")
    args = parser.parse_args()

    # convert to seconds
    args.timeout = args.timeout * 60
    args.mode = args.mode if args.mode is not None else ["sequence"]
    return args


def generate_manifest_entries(
    projects: list[str],
    mode_schema_pairs: list[tuple[str, str | None]],
    seeds: list[int],
    iterations: int,
    results_dir: str,
    timeout: int | None = None,
) -> list[dict]:
    entries = []
    manifest_index = 0

    for mode, schema_type in mode_schema_pairs:
        for project in projects:
            print("DEBUG project:", project, "mode:", mode, "schema:", schema_type)
            entrypoints = [util.find_entrypoints(project, mode)[0]]

            schema = None
            if schema_type is not None:
                schema = util.find_schema(project, schema_type)
                assert schema is not None

            for entrypoint, config in entrypoints:
                driver = path.basename(entrypoint).split(".")[0]

                for i in range(iterations):
                    outdir = f"{project}_{mode}_{schema_type}_{driver}_{i}_{manifest_index}"
                    outdir = path.join(results_dir, outdir)

                    schema_label = "none" if schema_type is None else schema_type

                    entry = {
                        "manifest_index": manifest_index,
                        "project": project,
                        "mode": mode,
                        "schema_type": schema_type,
                        "schema": schema,
                        "entrypoint": entrypoint,
                        "config_file_path": config,
                        "timeout": timeout,
                        "outdir": outdir,
                        "seed": seeds[i],
                        "labels": [project, mode, schema_label, driver, str(i)],
                        "driver": driver,
                        "iteration": i,
                        "library": project,
                        "request": 1,
                    }
                    entries.append(entry)
                    manifest_index += 1

    return entries


def main():
    args = arguments()

    projects = [
    p for p in util.discover_projects()
    if p not in {"node_modules", "infra", "scripts", "target", "__pycache__"}
]
    results_dir = args.results_dir or util.ensure_results_dir(dry_run=args.dry_run)
    seeds = [randint(0, 100000) for _ in range(args.iterations)]

    mode_schema_pairs = [
        ("sequence", "random"),
        ("sequence", "typescript"),
        ("sequence", "syntest")
    ]

    entries = generate_manifest_entries(
        projects=projects,
        mode_schema_pairs=mode_schema_pairs,
        iterations=args.iterations,
        results_dir=results_dir,
        seeds=seeds,
        timeout=args.timeout,
    )

    print(f"Generated {len(entries)} manifest entries")
    print(f"Results dir: {results_dir}")
    print(f"Manifest: {args.output}")

    if args.dry_run:
        for e in entries:
            print(
                e["manifest_index"],
                e["project"],
                e["mode"],
                e["schema_type"],
                e["driver"],
                e["seed"],
            )
        return

    with open(args.output, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    # summary_path = path.join(results_dir, "manifest_summary.txt")
    # with open(summary_path, "w", encoding="utf-8") as f:
    #     f.write(f"entries: {len(entries)}\n")
    #     f.write(f"timeout_seconds: {args.timeout}\n")
    #     for i, seed in enumerate(seeds):
    #         f.write(f"iter_{i}_seed: {seed}\n")

    print(f"Wrote {args.output}")
    # print(f"Wrote {summary_path}")


if __name__ == "__main__":
    main()
