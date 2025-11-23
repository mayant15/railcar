# Evaluation

## Benchmarks
Evaluate Railcar on JavaScript projects in OSS-Fuzz. These are in `examples/`. A couple projects are excluded:
- **pdf.js:** while it still remains in OSS-Fuzz, pdf.js maintainers have opted out of fuzzing and removed their harnesses
  in recent releases.
- **google-closure-library:** it has a fairly non-traditional usage pattern where a
`require('google-closure-library')` does not return a usable object. Instead, it runs side-effects that sets up a
global object which clients can then use. Railcar does not support this.
