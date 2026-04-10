#!/bin/bash
#SBATCH --job-name=railcar
#SBATCH --account=def-clx_cpu
#SBATCH --time=1-02:00:00
#SBATCH --cpus-per-task=1
#SBATCH --mem=4G
#SBATCH --array=0-43%64
#SBATCH --output=railcar_%A_%a.out

module load python/3.13
cd $SLURM_SUBMIT_DIR
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

python3 -u infra/slurm_make_jobs.py \
  --timeout 180 \
  --iterations 20 \
  --mode "sequence" \
  --output "infra/jobs.jsonl"

srun --cpu-bind=none bash -lc '
  echo "inside srun:"
  echo "SLURM_CPUS_PER_TASK=$SLURM_CPUS_PER_TASK"
  nproc
  taskset -pc $$
  grep Cpus_allowed_list /proc/self/status

  python3 -u infra/slurm_run_one.py \
    --manifest infra/jobs.jsonl \
    --index $SLURM_ARRAY_TASK_ID
'
