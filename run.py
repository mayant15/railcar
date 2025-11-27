import sqlite3
import pandas as pd
import os
import subprocess
import argparse
import matplotlib.pyplot as plt

def parse_args():
    parser = argparse.ArgumentParser(description="Example CLI")

    parser.add_argument(
        "-t", "--time",
        type=str,
        default="1m",
        help="Time (default: 1m)"
    )

    parser.add_argument(
        "-o", "--out",
        type=str,
        default="out",
        help="Output folder (default: out)"
    )

    parser.add_argument(
        "--target",
        type=str,
        required=True,
        help="Target file (required)"
    )

    parser.add_argument(
        "--schema",
        type=str,
        default="",
        help="Schema for target file"
    )

    parser.add_argument(
        "-p", "--port",
        type=int,
        default=1337,
        help="Port (default: 1337)"
    )

    parser.add_argument(
        "-i", "--iter",
        type=int,
        default=1,
        help="Number of iterator (default: 1)"
    )

    return parser.parse_args()

def main():
    args = parse_args()
    print("Parsed arguments:")
    print(args)

    TIME = args.time
    OUT = args.out
    TARGET = args.target
    PORT = args.port
    SEED = 67
    SCHEMA = args.schema
    ITER = args.iter

    base_port = PORT 
    timeout = f"timeout --signal=SIGTERM --kill-after=3s {TIME}"
    cargo_cmd_base = (
        "cargo run --release --bin railcar -- "
        f"--config railcar.config.js {f'--schema {SCHEMA}' if SCHEMA != "" else ''} "
        f"--seed {SEED}"
    )
    run_name = f'{OUT}'
    num_runs = ITER

    processes = []
    for i in range(1, num_runs + 1):
        outdir = f"{run_name}-{i}"
        port = base_port + i  
        subprocess.run(["rm", "-rf", outdir])
        subprocess.run(["mkdir", outdir])

        # Add --outdir and --port flags
        full_cmd = f"{timeout} bash -c '{cargo_cmd_base} --outdir {outdir} --port {port} {TARGET}'"
        print(f"Starting run {i} on port {port}: {full_cmd}")

        processes.append(subprocess.Popen(full_cmd, shell=True))

    # Wait for all runs to finish   
    for p in processes:
        p.wait()

    print(f"✅ All {num_runs} runs completed (or timed out).")

    base_folder = "."  # Current directory

    for i in range(1, num_runs + 1):
        outdir = f"{run_name}-{i}"
        db_path = os.path.join(base_folder, outdir, "metrics.db")
        csv_path = os.path.join(base_folder, outdir, f"{run_name}-{i}.csv")

        if not os.path.exists(db_path):
            print(f"⚠️ metrics.db not found in {outdir}, skipping.")
            continue

        try:
            # Connect to SQLite DB
            conn = sqlite3.connect(db_path)

            # Read heartbeat table into DataFrame
            df = pd.read_sql_query("SELECT * FROM heartbeat", conn)
            first_timestamp = df['timestamp'].iloc[0]
            df['second'] = df['timestamp'] - first_timestamp
            df['coverage_percentage'] = (df['coverage'] / df['total_edges'] * 100).round(2)

            # Export to CSV
            df.to_csv(csv_path, index=False)
            print(f"✅ Exported heartbeat table to {csv_path}")
            print(df)

            fig, ax1 = plt.subplots(figsize=(10, 6))
            
            color = 'tab:blue'
            ax1.set_xlabel('Seconds')
            ax1.set_ylabel('Coverage Percentage', color=color)
            ax1.plot(df['second'], df['coverage_percentage'], marker='o', color=color, label='Coverage vs Seconds')
            ax1.tick_params(axis='y', labelcolor=color)

            ax1.set_xlim(left=0)
            ax1.set_ylim(0, max(df['coverage_percentage']) + 1)

            ax2 = ax1.twiny()
            ax2.set_xlabel('Execs')
            ax2.set_xlim(ax1.get_xlim())  # Align with seconds axis

            # Map seconds to execs for ticks
            exec_ticks = [f"{e}" for e in df['execs']]
            ax2.set_xticks(df['second'])
            ax2.set_xticklabels(exec_ticks, rotation=90)

            # Title and grid
            plt.title(f'Coverage Percentage vs Seconds and Execs of run {"with schema" if SCHEMA != "" else "without schema"} max-covereage={max(df['coverage_percentage'])}% last-reported-time-unit(s)={max(df['second'])}')
            ax1.grid(True)

            plt.tight_layout()

            plt.savefig(OUT + ".png")
            plt.show()

            

            conn.close()
        except Exception as e:
            print(f"❌ Error processing {outdir}: {e}")


if __name__ == "__main__":
    main()