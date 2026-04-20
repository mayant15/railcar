#!/bin/bash
#SBATCH --job-name=railcar
#SBATCH --account=def-clx_cpu
#SBATCH --time=05:00:00
#SBATCH --cpus-per-task=1
#SBATCH --mem=4G
#SBATCH --array=0-959%64
#SBATCH --output=railcar_%A_%a.out

module load python/3.13
cd "$SLURM_SUBMIT_DIR"
source .venv/bin/activate
export RUST_BACKTRACE=full
export RUST_LOG=debug

echo "SLURM_CPUS_PER_TASK=$SLURM_CPUS_PER_TASK"
echo "nproc before srun:"
nproc
echo "taskset before srun:"
taskset -pc $$
echo "allowed before srun:"
grep Cpus_allowed_list /proc/self/status
which node
node -v

srun --cpu-bind=none bash -lc '
  python3 -u infra/slurm_run_one.py \
    --manifest infra/jobs.jsonl \
    --index $SLURM_ARRAY_TASK_ID
  status=$?

  RUN_DIR=$(python3 - <<PY
import json
idx = int("'"$SLURM_ARRAY_TASK_ID"'")
with open("infra/jobs.jsonl") as f:
    for i, line in enumerate(f):
        if i == idx:
            job = json.loads(line)
            print(job["outdir"])
            break
PY
)

  TRACE="$RUN_DIR/cleanup.log"

  archive_and_delete () {
    local name="$1"
    local dir="$RUN_DIR/$name"
    local archive="$RUN_DIR/$name.tar.gz"

    if [ -d "$dir" ]; then
      echo "$name exists"
      echo "archive target=$archive"

      if tar -czf "$archive" -C "$RUN_DIR" "$name"; then
        echo "tar success for $name"

        rm -rf "$dir"
        rm_status=$?
        echo "rm exit code for $name=$rm_status"

        if [ -d "$dir" ]; then
          echo "$name still exists after rm"
        else
          echo "$name deleted successfully"
        fi
      else
        echo "tar failed for $name"
      fi
    else
      echo "$name directory not found"
    fi
  }

{
  echo "==== cleanup start ===="
  date
  echo "status=$status"
  echo "RUN_DIR=$RUN_DIR"
  PARENT_DIR=$(dirname "$RUN_DIR")
  echo "PARENT_DIR=$PARENT_DIR"

  echo "before cleanup:"
  ls -l "$RUN_DIR" 2>&1

  echo "file count BEFORE:"
  total_before=$(find "$RUN_DIR" -type f | wc -l)
  parent_before=$(find "$PARENT_DIR" -type f | wc -l)
  echo "run_dir files: $total_before"
  echo "parent_dir files: $parent_before"

  if [ -d "$RUN_DIR/corpus" ]; then
    corpus_before=$(find "$RUN_DIR/corpus" -type f | wc -l)
    echo "corpus files: $corpus_before"
  fi

  if [ -d "$RUN_DIR/crashes" ]; then
    crashes_before=$(find "$RUN_DIR/crashes" -type f | wc -l)
    echo "crashes files: $crashes_before"
  fi

  archive_and_delete corpus
  archive_and_delete crashes

  echo "after cleanup:"
  ls -l "$RUN_DIR" 2>&1

  echo "file count AFTER:"
  total_after=$(find "$RUN_DIR" -type f | wc -l)
  parent_after=$(find "$PARENT_DIR" -type f | wc -l)
  echo "run_dir files: $total_after"
  echo "parent_dir files: $parent_after"

  echo "run_dir reduction: $((total_before - total_after)) files"
  echo "parent_dir reduction: $((parent_before - parent_after)) files"

  echo "run dir size:"
  du -sh "$RUN_DIR" 2>&1 || true

  echo "==== cleanup end ===="
} >> "$TRACE" 2>&1
  exit $status
'
