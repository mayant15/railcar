from typing import TypeVar, Generic
from dataclasses import dataclass

T = TypeVar('T')


@dataclass
class Request(Generic[T]):
    payload: T
    library: str
    request: int = 1
    """Number of cores that this request needs"""


@dataclass
class Job(Generic[T]):
    payload: T
    cores: list[int]


def _validate_schedule(schedule: list[list[Job[T]]], requests: list[Request[T]], num_procs: int):
    """
    Checks some common-sense invariants on a schedule for `jobs` on `num_procs` processes.
    """
    total = 0
    for row in schedule:
        total += len(row)

        # 1. Each row must be runnable in parallel (len < num_procs)
        assert len(row) <= num_procs

        cores = []
        for job in row:
            cores += (job.cores)

            # 2. Each job must have a non-empty list of cores
            assert len(job.cores) > 0

        # 3. All jobs in the same row must have distinct cores
        assert len(cores) == len(set(cores))

    # 4. All jobs must be scheduled
    assert total == len(requests)


# TODO: assign different runs of the same library to the same core
def schedule(requests: list[Request[T]], num_procs: int) -> list[list[Job[T]]]:
    """
    Schedule a set of jobs over `num_procs` processes.  Returns a 2D matrix, where
    each row can run in parallel.
    """

    schedule: list[list[Job[T]]] = [[]]
    row = 0
    next_core = 0

    for req_i, req in enumerate(requests):
        # if we don't have enough cores available, start the next row
        if num_procs - next_core < req.request:
            schedule.append([])
            row += 1
            next_core = 0

        cores = [next_core + i for i in range(req.request)]
        next_core += req.request

        schedule[row].append(Job(payload=req.payload, cores=cores))

    _validate_schedule(schedule, requests, num_procs)
    return schedule
