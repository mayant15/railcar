# Evaluation

## Benchmarks
Evaluate Railcar on JavaScript projects in OSS-Fuzz. These are in `examples/`. A couple projects are excluded:
- **pdf.js:** while it still remains in OSS-Fuzz, pdf.js maintainers have opted out of fuzzing and removed their harnesses
in recent releases.
- **google-closure-library:** it has a fairly non-traditional usage pattern where a
`require('google-closure-library')` does not return a usable object. Instead, it runs side-effects that sets up a
global object which clients can then use. Railcar does not support this.
- **promise-polyfill:** Railcar only supports `Promise`-based asynchronous code. It needs `instanceof Promise` checks in
a few places. The `Promise` class exported by `promise-polyfill` is _not the same_ as the standard `Promise` class, so
these `instanceof` checks fail.
- **d3:** it includes several non-Promise async and browser-dependent methods for interactive visualization. The d3
OSS-Fuzz driver only tests its CSV parser.
