import pandas as pd
import numpy as np
import glob
import re
import json
import sqlite3
import os


def branch_coverage(results_dir: str):
    data = []
    for path in glob.iglob(f"{results_dir}/**/coverage/coverage.json", recursive=True):
        matches = re.search('iter_(.)/(.*)/coverage/coverage.json', path)

        assert matches is not None
        iteration = matches.group(1)
        config = matches.group(2)

        with open(path) as fp:
            branch_coverage = json.load(fp)["branch"]

        data.append({
            "iteration": iteration,
            "config": config,
            "branch_coverage": branch_coverage
        })

    df = pd.DataFrame(data)
    return df.groupby('config')['branch_coverage'].mean()


def execs_per_sec(results_dir: str, timeout: int, iterations: int):
    conn = sqlite3.connect(f"{results_dir}/metrics.db")
    execs = pd.read_sql("select * from heartbeat", conn)

    # get total execs from the last heartbeat for this run
    execs = execs.groupby(['config', 'iteration']).last()
    execs = execs.reset_index().set_index('config')

    # return total executions / total time over all iterations
    return execs.groupby('config')['execs'].sum() / (timeout * iterations)


def corpus_size(results_dir: str):
    data = []
    for path in glob.iglob(f"{results_dir}/**/crashes", recursive=True):
        matches = re.search('iter_(.)/(.*)/crashes', path)

        assert matches is not None
        iteration = matches.group(1)
        config = matches.group(2)

        files = os.listdir(os.path.realpath(path))
        crashes = [f for f in files if not f.startswith(".")]

        files = os.listdir(os.path.join(
            os.path.dirname(os.path.realpath(path)),
            "corpus"
        ))
        corpus = [f for f in files if not f.startswith(".")]

        data.append({
            "iteration": iteration,
            "config": config,
            "objectives": len(crashes),
            "corpus": len(corpus)
        })

    df = pd.DataFrame(data)
    return df.groupby('config')[['objectives', 'corpus']].sum()


def healthchecks(results_dir: str, timeout: int, iterations: int):
    out = pd.DataFrame()
    out['branch_coverage'] = branch_coverage(results_dir)
    out['execs/s'] = execs_per_sec(results_dir, timeout, iterations)

    # Unit tests for example don't have a corpus, set them to nan
    try:
        sizes = corpus_size(results_dir)
        out['objectives'] = sizes['objectives']
        out['corpus'] = sizes['corpus']
    except Exception:
        out['objectives'] = np.nan
        out['corpus'] = np.nan

    return out
