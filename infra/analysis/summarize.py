################################################################################
# Given an output directory, pretty print an overall coverage table.
################################################################################

from argparse import ArgumentParser

import pandas as pd
import sqlite3 as sql


pd.options.display.float_format = "{:,.2f}".format


def load_db(path: str) -> pd.DataFrame:
    """
    Load heartbeats from the given database then clean up the columns a bit.
    """

    conn = sql.connect(path)
    df = pd.read_sql("SELECT coverage, labels, total_edges FROM heartbeat", conn)

    # Split up comma-separated labels into meaningful columns
    df = df.join(df['labels'].str.split(",", expand=True).rename(columns={0: "project", 1: "mode", 2: "schema", 3: "driver", 4: "iter"}))

    # Iterations are strings still, cast to int
    df['iter'] = df['iter'].astype(int)

    return df.drop(columns=["labels", "mode", "driver"])


def compute_coverage(df: pd.DataFrame) -> pd.DataFrame:
    # Pick the last heartbeat for each run, instead of processing all timestamps
    df = df.groupby(["project", "schema", "iter"]).last()

    # Coverage percentage
    df['pct'] = df['coverage'] * 100 / df['total_edges']

    # Percentage for each project x schema combo, averaged over iterations
    df = df['pct'].groupby(["project", "schema"]).mean()

    # Convert series with multi-index into a dataframe, project rows and schema columns
    return df.unstack(level="schema")


def main():
    parser = ArgumentParser()
    parser.add_argument("db_path")
    args = parser.parse_args()

    df = load_db(args.db_path)
    df = compute_coverage(df)

    # Print with two decimals for floats
    print(df)

if __name__ == "__main__":
    main()
