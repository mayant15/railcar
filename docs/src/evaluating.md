# Evaluating Railcar

We use several metrics to evaluate Railcar's performance.

## The "Results" Directory

Default invocations of `infra/fuzz.py` create a "results" directory named `railcar-results-<timestamp>/`.

### Validation and Post-Processing

Run the post-processing script to validate results and generate the heartbeat database. This is a
database of metrics collected over time as the fuzzer runs.
```bash
bun run ./scripts/post-process.ts <results-dir>
```
## Metrics Database

> **TODO**: Move the heartbeats table into the metrics database as well.

To analyze Railcar's behaviour on different libraries, we have a second database with some _static_
and _dynamic_ metrics.

### Static Metrics

First, run the this script to collect static metrics.
```bash
node ./scripts/make-metrics-db.ts 
```
Note that this is Node.js and not Bun, because we use `registerHooks()` from `node:module` which
Bun does not seem to support yet. This script runs a few static analyzers on our benchmark libraries
and constructs a database of _static_ metrics. There are two tables.

The `branches` table has the following main columns:

|Column|Type|Description|
|------|----|-----------|
| id   | Text | A unique ID for each branch, based on a hash of its location and properties. |
| kind | Text | Whether this is an if-statement, a switch, a loop etc. |
| arm_index | Integer | Which arm is this, eg. a case for switch. |
| continuation | Boolean | Whether this is a _continuation_ branch. |
| function_id | Text | An ID for the function this branch belongs to. |
| path | Text | Source text for all if-condition predicates that must be true to get to this branch. |
| depth | Integer | Number of if-condition predicates in path. |
| narrowing_score | Integer | Number of if-condition predicates on path that look like they refine types. |

In addition, there's also columns for source location: file path, start and end line numbers, column
numbers, and byte offsets.

The `functions` table has the following columns, in addition to source location ones:
| Column | Type | Description |
|--------|------|-------------|
| id | Text | A unique ID for each function, based on a hash of its location and properties. Joins to `function_id` in the `branches` table. |
| library | Text | The benchmark library this function belongs to. |
| name | Text | A name for this function, if available. |
| type | Text | Babel AST node types, eg. `FunctionDeclaration` or `ClassMethod`. |
| async | Boolean | Is this function `async`? |
| generator | Boolean | Is this function a generator? |
| params | Integer | Number of declared parameters, where rest/defaults each count as one. |
| complexity | Integer | Cyclomatic complexity, computed the same way [eslint does](https://github.com/eslint/eslint/blob/main/lib/rules/complexity.js/). |
| num_property_accesses | Integer | Number of member access AST nodes in this function. |
| num_string_operations | Integer | Number of AST nodes in this function that look like string operations. |

### Dynamic Metrics

Once we have a results directory from an evaluation run, collect coverage data with:
```bash
./scripts/coverage-all.sh <results-dir>
```
This replays all corpus inputs and dumps code coverage data into a `./coverage` directory. Then use
this script to add a `coverage` table to the metrics database from the previous section:
```bash
node ./scripts/coverage-to-sqlite.ts <metrics-db> <coverage-dir>
```
The `coverage` table has the following columns:
| Column | Type | Description |
|--------|------|-------------|
| branch_id | Text | The branch this row carries data for. Joins to `id` in `branches`. |
| schema | Text | The schema kind for this fuzzer run. |
| run_id | Integer | Iteration number for this fuzzer run, since we run each library/schema combination multiple times. |
| hitcount | Integer | Number of times this branch was hit. |

Coupled with static metrics from the `branches` and `functions` tables, this lets us analyze fuzzer
performance by looking at factors affecting the probability of hitting particular branches.

## V8 Code Coverage

The coverage collection script uses Node's native [`NODE_V8_COVERAGE`](https://nodejs.org/api/cli.html#node_v8_coveragedir), which only identifies
functions and branches with their [start and end offsets](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/#type-CoverageRange). We try to map these functions and branches
from their offsets back to our function and branch IDs, using our source location columns.

To make this easier, our branch taxonomy is as close as possible to [V8's](https://docs.google.com/document/d/1wCydi2HEZRF0skDeLb6CH0abZnTyVo5Vz5u-jhwi7es/). We have zero-width _continuation_
branches after branching constructs to account for non-local effects. Every file also gets a single top-level
"FnEntry" branch corresponding with V8's whole-script, empty function name coverage object.
