# Design

## Types

Linearity in railcar? Return the object that's the target of method calls

## Instrumentation

Works through `registerHooks()` from `node:module`. But, this only works for imports called
_after_ the hooks are registered. If the config itself needs the library (like `@xmldom/xmldom` did),
that import happens _before_ the hooks.

We should allow users to pre-instrument their files.
