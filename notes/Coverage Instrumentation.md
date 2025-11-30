We instrument libraries at run time with [Node.js hooks](https://nodejs.org/docs/latest-v24.x/api/module.html#customization-hooks). This is to support dynamic imports.

This only works for imports called _after_ the hooks are registered. If the config itself needs the library (like `@xmldom/xmldom` did), that import happens _before_ the hooks.

We should allow users to instrument their files upfront if they only use static imports.