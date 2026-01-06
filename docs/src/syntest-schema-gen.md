# Generating SynTest schemas

The repository has some schemas in `examples/` for testing Railcar. Here is how to regenerate them:

- **fast-xml-parser**
  - Clone fast-xml-parser (the one in `node_modules` is minified)
  - Change webpack config in the project to "development"
  - Build
  - `examples/` contains an `fxp.full.js` bundle for reference
- **tslib**
  - Use `node_modules/tslib/tslib.js`
- **pako**
  - Use `node_modules/pako/dist/pako.js`
- **sharp**
  - It runs but fails to infer anything (so the output is just any) because of `syntest/lib/type/discovery/relation/RelationVisitor.js:339:21`
  - Also tried to build with `npx esbuild lib/sharp.js --bundle --platform=browser --outfile=sharp.bundle.js`
- **redux**
  - Use `node_modules/redux/dist/redux.mjs`
- **jimp**
  - Go to `node_modules/jimp/dist/browser` (or copy to another dir for safety)
  - `npx esbuild index.js --bundle --platform=neutral --outfile=jimp.browser.js`
  - Run syntest on the jimp.browser.js ~ 1887 line of schema
  - There is a bundle in `examples/` for reference
- **jpeg-js**
  - Copy `node_modules/jpeg-js/` to somewhere else
  - Run this: `npx esbuild index.js --bundle --platform=neutral --outfile=jpeg-js.bundle.js`
  - Run SynTest on `jpeg-js.bundle.js`
  - Reference bundle in `examples/`
- **js-yaml**
  - Use `node_modules/js-yaml/dist/js-yaml.js`
