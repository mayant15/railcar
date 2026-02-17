# AGENTS.md

## Overall Commands

- Build: `mise build`
- Test: `mise test`
- Format: `mise fix`

## Repository Structure

Railcar is a monorepo with TypeScript and Rust packages.
- `packages/cli` — Rust CLI entry point
- `packages/fuzzer` — Rust fuzzer core (uses LibAFL)
- `packages/worker` — TypeScript worker
- `packages/worker-sys` — Rust <-> Node native bindings (with napi-rs)
- `packages/inference` — TypeScript type inference tool
- `packages/support` — TypeScript support library
- `packages/reporter` — TypeScript web reporter UI
- `packages/tools` — Rust utility tools

## Running Tools

Railcar comes with a number of support tools.
- `railcar-infer`: CLI for automatic type inference, run with `npx railcar-infer [options]`

## More Granular Tests

There are three test suites:
- `packages/inference`: tests for type inference tools.
  - Run with `bun test [test-file]` in `packages/inference`
  - Run a subset with `bun test [test-file] --test-name-pattern <patter>`
- `packages/worker`: tests for the worker sub-process.
  - Run with `bun test [test-file]` in `packages/worker`
  - Run a subset with `bun test [test-file] --test-name-pattern <patter>`
- Rust tests
  - Run with `cargo test`
  - Run for a specific package with `cargo test -p <package>`

## Conventions

- For Rust code, see @clippy.toml for project-specific conventions
