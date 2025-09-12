from evaluator.base import Project, Config
from evaluator.railcar import Railcar
from evaluator.unit_test import UnitTest
from evaluator.jazzer import Jazzer
from evaluator.healthcheck import healthchecks
from multiprocessing import Pool
from random import randint
from socket import gethostname
from datetime import datetime
from shutil import rmtree

import os
import subprocess as sp


def git_version():
    proc = sp.run([
        "git", "log", "--pretty=oneline", "-n", "1", "--no-decorate"
    ], capture_output=True, text=True)
    return proc.stdout.strip()


PROJECTS = {
    "example": Project(
        name="example",
        include="index.js",
        ignored=[
            "Input must be a string",
            "Level must be a number",
            "Invalid compression level",
        ]
    ),
    "pako": Project(
        name="pako",
        include="lib/",
        ignored=[
            "need dictionary",
            "stream error",
            "buffer error",
            "data error",
            "invalid",
            "incorrect",
            "unknown",
            "header crc mismatch",
            "too many length or distance symbols",
        ],
        unit_test_cmd=["mocha"]
    ),
    "fast-xml-parser": Project(
        name="fast-xml-parser",
        include="src/",
        exclude="src/v5/",
        library_main="src/fxp.js",
        ignored=[
            "Cannot read properties",
            "Invalid",
            "Unclosed",
            "Unexpected",
            "is not closed",
            "is not expected",
            "is not allowed",
            "is not permitted",
            "is an invalid name",
            "are not supported",
            "Start tag expected",
            "Expected closing tag",
            "An entity must be set without",
            "Entity value can't have",
            "boolean attribute",
            "Multiple possible root nodes found",
            "Extra text at the end",
            "has not been opened",
            "Attribute",
            "Attributes",
            "Closing tag",
            "XML data is accepted in String or Bytes[] form.",
            "XML declaration allowed only at the start of the document",
            "Unpaired tag can not",
        ],
        unit_test_cmd=["jasmine", "spec/*spec.js"]
    ),
    "js-yaml": Project(
        name="js-yaml",
        include="lib/",
        ignored=[
            "is removed in js-yaml 4",
            "Unknown",
            "unknown",
            "undeclared",
            "unidentified",
            "unexpected",
            "unacceptable",
            "bad indentation",
            "is not allowed",
            "is not supported",
            "are not supported",
            "ill-formed",
            "malformed",
            "cannot contain",
            "must contain",
            "should not have",
            "can not read",
            "cannot resolve",
            "must not be",
            "may not be",
            "should be",
            "must be",
            "must not be used",
            "is expected",
            "is not allowed",
            "duplication of",
            "duplicated mapping key",
            "Specified list of YAML types",
            "tag resolver accepts not",
            "YAML directive accepts exactly one argument",
            "TAG directive accepts exactly two arguments",
            "there is a previously declared suffix",
            "the stream contains non-printable characters",
            "Multi tags can only be listed as explicit",
            "missed comma between flow collection entries",
            "expected a single document in the stream, but found more",
            "expected hexadecimal character",
            "expected valid JSON character",
            "expected the node content",
            "bad explicit indentation width",
            "repeat of a chomping mode identifier",
            "repeat of an indentation width identifier",
            "bad indentation",
            "incomplete explicit mapping pair",
        ],
        unit_test_cmd=["mocha"]
    ),
    "protobuf-js": Project(
        name="protobuf-js",
        include="src/",
        ignored=[
            "does not exist",
            "illegal",
            "invalid",
            "must be",
            "duplicate",
            "no such",
            "is not a member of",
            "JSON at position",  # passes input string to JSON.parse()
        ],
        skip_endpoints=[
            "fetch",
            "util.fetch",
            "Root.fetch",
            "Root.load",
            "load",
            "rpc.Service.rpcCall",
            "util.asPromise",
        ],
        unit_test_cmd=["npm", "run", "test:sources"]
    ),
    "sharp": Project(
        name="sharp",
        include="lib/",
        library_main="lib/index.js",
        ignored=[
            "is empty",
            "Invalid",
            "Expected",
            "Unsupported",
            "JP2 output requires libvips",
            "Missing output file path",
            "Only gaussian noise is supported at the moment",
        ],
        skip_endpoints=[
            "Sharp.cork",
            "Sharp.uncork",
            "Sharp.write",
            "Sharp.on",
            "Sharp.off",
            "Sharp.once",
            "Sharp.read",
            "Sharp.pipe",
            "Sharp.unpipe",
            "Sharp.addListener",
            "Sharp.removeListener",
            "Sharp.removeAllListeners",
            "Sharp.pause",
            "Sharp.resume",
            "Sharp.wrap",
            "Sharp.iterator",
            "Sharp.filter",
            "Sharp.drop",
            "Sharp.flatMap",
            "Sharp.push",
            "Sharp.unshift",
            "Sharp.end",
            "Sharp.emit",
            "Sharp.toArray",
        ],
        unit_test_cmd=["mocha"]
    )
}


def add_unit_tests(
    projects: list[str],
    iterations: int,
    results_dir: str
) -> list[list[Config]]:
    tool = UnitTest()
    tool.build()

    configs: list[list[Config]] = []
    for project_name in projects:
        cs: list[Config] = []
        for i in range(iterations):
            cs.append(
                Config(tool, PROJECTS[project_name], UnitTest.Args(
                    out_dir=os.path.join(
                        results_dir,
                        f"iter_{i}",
                        f"{project_name}_testsuite"
                    ),
                    core=2*i,
                ))
            )
        configs.append(cs)

    return configs


def add_jazzer_tests(
    projects: list[str],
    iterations: int,
    results_dir: str,
    timeout: int,
    seeds: list[int]
) -> list[list[Config]]:
    tool = Jazzer()
    tool.build()

    configs: list[list[Config]] = []
    for project_name in projects:
        cs: list[Config] = []
        for i in range(iterations):
            cs.append(
                Config(tool, PROJECTS[project_name], Jazzer.Args(
                    out_dir=os.path.join(
                        results_dir,
                        f"iter_{i}",
                        tool.config_str(project_name),
                    ),
                    timeout=timeout,
                    seed=seeds[i],
                    core=2*i,
                ))
            )
        configs.append(cs)

    return configs


def add_railcar(
    projects: list[str],
    drivers: list[str],
    schemas: list[str],
    mutations: list[str],
    seeds: list[int],
    iterations: int,
    results_dir: str,
    timeout: int,
) -> list[list[Config]]:
    tool = Railcar()
    tool.build()

    configs: list[list[Config]] = []
    for project_name in projects:
        project = PROJECTS[project_name]
        for driver in drivers:
            if driver == "bytes":
                cs: list[Config] = []
                for i in range(iterations):
                    out_dir = os.path.join(
                        results_dir,
                        f"iter_{i}",
                        f"{project.name}_{driver}_none_none"
                    )
                    cs.append(Config(tool, project, Railcar.RunArgs(
                        timeout=timeout,
                        out_dir=out_dir,
                        seed=seeds[i],
                        mode="bytes",
                        schema=None,
                        simple=None,
                        core=2*i,
                    )))
                configs.append(cs)
            elif driver == "graph":
                for schema in schemas:
                    for mutation in mutations:
                        cs = []
                        for i in range(iterations):
                            out_dir = os.path.join(
                                results_dir,
                                f"iter_{i}",
                                f"{project.name}_{driver}_{schema}_{mutation}"
                            )
                            cs.append(
                                Config(tool, project, Railcar.RunArgs(
                                    timeout=timeout,
                                    out_dir=out_dir,
                                    seed=seeds[i],
                                    mode="graph",
                                    schema=schema,
                                    simple=(mutation == "simple"),
                                    core=2*i,
                                )))
                        configs.append(cs)
            elif driver == "parametric":
                for schema in schemas:
                    cs = []
                    for i in range(iterations):
                        out_dir = os.path.join(
                            results_dir,
                            f"iter_{i}",
                            f"{project.name}_{driver}_{schema}_none"
                        )
                        cs.append(Config(tool, project, Railcar.RunArgs(
                            timeout=timeout,
                            out_dir=out_dir,
                            seed=seeds[i],
                            mode="parametric",
                            schema=schema,
                            simple=None,
                            core=2*i
                        )))
                    configs.append(cs)
            else:
                raise ValueError("invalid driver")

    return configs


def execute_config(config: Config):
    config.run()


def main() -> None:
    timeout: int = 60  # in seconds
    iterations: int = 6
    projects: list[str] = [
        # "example",
        "fast-xml-parser",
        "pako",
        "js-yaml",
        "protobuf-js",
        "sharp",
    ]
    drivers = [
        "bytes",
        "graph",
        "parametric"
    ]
    mutations: list[str] = [
        "regular",
        "simple"
    ]

    processes_pool: int = iterations
    schemas: list[str] = ["any"]
    seeds = [97601, 7300, 40429, 52328, 53129, 45122, 11551, 32143]
    # seeds = [randint(0, 100000) for i in range(iterations)]

    results_dir = os.path.join(
        os.path.dirname(os.path.realpath(__file__)),
        "results"
    )

    if os.path.exists(results_dir):
        rmtree(results_dir)
    os.makedirs(results_dir, exist_ok=False)

    summary = ""
    summary += "{}\n".format(git_version())
    summary += "Ran on {}\n".format(gethostname())
    summary += "Timeout: {} seconds\n".format(timeout)
    summary += "\n"
    for i in range(iterations):
        summary += "iter_{} seed: {}\n".format(i, seeds[i])

    # list of list of configs
    # run outer list serially, inner list in parallel
    configs: list[list[Config]] = []

    # make configs
    # configs += add_unit_tests(projects, iterations, results_dir)
    # configs += add_jazzer_tests(
    #     projects,
    #     iterations,
    #     results_dir,
    #     timeout,
    #     seeds
    # )
    configs += add_railcar(
        projects=projects,
        drivers=drivers,
        iterations=iterations,
        mutations=mutations,
        results_dir=results_dir,
        schemas=schemas,
        seeds=seeds,
        timeout=timeout,
    )

    for cs in configs:
        with Pool(processes_pool) as pool:
            pool.map(execute_config, cs)

    # Collect all data into an sqlite database
    sp.run([
        "cargo", "run", "--release", "--bin", "makedb", "--", results_dir
    ])

    # Run healthchecks
    df = healthchecks(results_dir, timeout, iterations)
    summary += "\n{}\n".format(df.to_string())

    # Write summary file
    with open(os.path.join(results_dir, "summary.txt"), "w") as f:
        f.write(summary)

    # Rename results directory
    timestamp = datetime.now().strftime("%Y-%m-%d-%s")
    new_results_dir = os.path.join(
        os.path.dirname(results_dir),
        f"results-{timestamp}"
    )
    os.rename(results_dir, new_results_dir)


if __name__ == '__main__':
    main()
