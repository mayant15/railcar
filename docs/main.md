# Railcar

<abstract>

# Introduction

# Design

## Types

Linearity in railcar? Return the object that's the target of method calls

## Instrumentation

Works through `registerHooks()` from `node:module`. But, this only works for imports called
_after_ the hooks are registered. If the config itself needs the library (like `@xmldom/xmldom` did),
that import happens _before_ the hooks.

We should allow users to pre-instrument their files.

## Reporter

Railcar comes with a lightweight web app to monitor a fuzzing campaign. So far this is not distributed
to end users and is only available in the source repo. The web app scrapes fuzzer status every 15
seconds (libAFL client heartbeat) and pushes updates to a client UI.

# Evaluation

## Benchmarks
Evaluate Railcar on JavaScript projects in OSS-Fuzz. These are in `examples/`. A couple projects are excluded:
- **pdf.js:** while it still remains in OSS-Fuzz, pdf.js maintainers have opted out of fuzzing and removed their harnesses
  in recent releases.
- **google-closure-library:** it has a fairly non-traditional usage pattern where a
`require('google-closure-library')` does not return a usable object. Instead, it runs side-effects that sets up a
global object which clients can then use. Railcar does not support this.

