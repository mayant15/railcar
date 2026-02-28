# Changes to Syntest

I have ran `bun add esbuild --dev` && `bun add patch-package --dev`

I've also ran custompatch with: `bunx patch-package @syntest/analysis-javascript`

Before running anything, you should run: `bunx patch-package`

# Generating SynTest schemas

## Bundling projects

The repository has some schemas in `examples/` for testing Railcar. Here is how to regenerate them:

to custom-build bundled js, you need to install esbuild npm package in each respective repository.

**Bundle the project:**

- **Typescript**
  - Use default node_module file `node_modules/typescript/lib/typescript.js`
- **ua-parser-js**
  - Use default node_module file: `node_modules/ua-parser-js/src/main/ua-parser.js`
- **protobufjs**
  - Use default node_module file: `node_modules/protobufjs/dist/protobuf.js`
- **tslib**
  - Use default node_module file `node_modules/tslib/tslib.js`
- **pako**
  - Use default node_module file `node_modules/pako/dist/pako.js`
- **redux**
  - Use default node_module file `node_modules/redux/dist/redux.mjs`
- **angular** 
  - Use default node_module file: `node_modules/@angular/compiler/fesm2022/compiler.mjs`
- **js-yaml**
  - Use default node_module file `node_modules/js-yaml/dist/js-yaml.js`

- **sharp**
  - Build like this: `bunx esbuild node_modules/sharp/lib/index.js --bundle --format=cjs --platform=node --outfile=sharp.bundle.js`
- **jimp**
  - Build like this: `bunx esbuild node_modules/jimp/dist/commonjs/index.js --bundle --platform=node --outfile=jimp-common.js`
- **lit**
  - Build like this: `bunx esbuild node_modules/lit/index.js --bundle --format=esm --platform=node --outfile=lit.js`
- **lodash**
  - Build like this: `bunx esbuild node_modules/lodash/index.js --bundle --format=esm --platform=node --outfile=lodash.bundle.js`
- **turf**
  - Build like this: `bunx esbuild node_modules/@turf/turf/dist/esm/index.js --bundle --format=esm --platform=node --outfile=turf.bundle.js`
- **xml2js**
  - Build like this: `bunx esbuild node_modules/xml2js/lib/xml2js.js --bundle --format=esm --platform=node --outfile=xml2.js`
- **xmldom**
  - Build like this: `bunx esbuild node_modules/@xmldom/xmldom/lib/index.js --bundle --format=esm --platform=node --outfile=xmldom.js`

- **fast-xml-parser**
  - Clone fast-xml-parser (the one in `node_modules` is minified)
  - Change webpack config in the project to "development"
  - Build
  - `examples/` contains an `fxp.full.js` bundle for reference
  - OR, build it like this: `bunx esbuild src/fxp.js --bundle --platform=node --outfile=fxp.full.js`
- **jpeg-js**
  - Copy `node_modules/jpeg-js/` to somewhere else
  - Run this: `bunx esbuild index.js --bundle --outfile=jpeg-js.bundle.js`
  - Run SynTest on `jpeg-js.bundle.js`
  - Reference bundle in `examples/`

## Creating schema:

- **Here's the example to get typescript syntest schema, for other projects, include the respective railcar.config.js and output to the respetive directory:**

  - `bunx railcar-infer --syntest --entrypoint node_modules/typescript/lib/typescript.js --config examples/typescript/railcar.config.js -o examples/typescript/syntest.json`

- A reference script can be checked out in scripts/build-syntest-json.sh: `./scripts/build-syntest-json.sh --help`

```
  • examples/angular/syntest.json
  • examples/fast-xml-parser/syntest.json
  • examples/jimp/syntest.json
  • examples/jpeg-js/syntest.json
  • examples/js-yaml/syntest.json
  • examples/lit/syntest.json
  • examples/lodash/syntest.json
  • examples/pako/syntest.json
  • examples/protobufjs/syntest.json
  • examples/redux/syntest.json
  • examples/sharp/syntest.json
  • examples/tslib/syntest.json
  • examples/turf/syntest.json
  • examples/typescript/syntest.json
  • examples/ua-parser-js/syntest.json
  • examples/xml2js/syntest.json
  • examples/xmldom/syntest.json
```

(building typescript should take a very long time, 4907 endpoints to infer)
