# Generating SynTest schemas

The repository has some schemas in `examples/` for testing Railcar. Here is how to regenerate them:

to custom-build bundled js, you need to install esbuild npm package in each respective repository.

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
  - Build like this: `npx esbuild node_modules/sharp/lib/index.js --bundle --format=cjs --platform=node --outfile=sharp.bundle.js`
- **jimp**
  - Build like this: `npx esbuild node_modules/jimp/dist/commonjs/index.js --bundle --platform=node --outfile=jimp-common.js`
- **lit**
  - Build like this: `npx esbuild node_modules/lit/index.js --bundle --format=esm --platform=node --outfile=lit.js`
- **lodash**
  - Build like this: `npx esbuild node_modules/lodash/index.js --bundle --format=esm --platform=node --outfile=lodash.bundle.js`
- **turf**
  - Build like this: `npx esbuild node_modules/@turf/turf/dist/esm/index.js --bundle --format=esm --platform=node --outfile=turf.bundle.js`
- **xml2js**
  - Build like this: `npx esbuild node_modules/xml2js/lib/xml2js.js --bundle --format=esm --platform=node --outfile=xml2.js`
- **xmldom**
  - Build like this: `npx esbuild node_modules/@xmldom/xmldom/lib/index.js --bundle --format=esm --platform=node --outfile=xmldom.js`

- **fast-xml-parser**
  - Clone fast-xml-parser (the one in `node_modules` is minified)
  - Change webpack config in the project to "development"
  - Build
  - `examples/` contains an `fxp.full.js` bundle for reference
  - OR, build it like this: `npx esbuild src/fxp.js --bundle --platform=node --outfile=fxp.full.js`
- **jpeg-js**
  - Copy `node_modules/jpeg-js/` to somewhere else
  - Run this: `npx esbuild index.js --bundle --platform=neutral --outfile=jpeg-js.bundle.js`
  - Run SynTest on `jpeg-js.bundle.js`
  - Reference bundle in `examples/`