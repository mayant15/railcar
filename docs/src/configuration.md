# Configuration

Railcar allows configuration via a configuration file. By default, it looks for a `railcar.config.js` file
in the current working directory. It allows three options:
```javascript
module.exports = {
    isBug: (error) => true,
    shouldInstrument: (filename) => true,
    skipMethods: [],
}
```
- `isBug`: A function which receives a thrown value, then decides if it is an actual bug or a false positive.
- `shouldInstrument`: A function that picks which files to instrument for code coverage.
- `skipMethods`: Library APIs to avoid in generated harnesses.

Railcar provides a convenience function for oracles that simply match on error messages.
```javascript
const {makeInvalidErrorMessageOracle} = require("@railcar/support")
module.exports = {
    isBug: makeInvalidErrorMessageOracle(["bad input", /* ... */])
}
```
