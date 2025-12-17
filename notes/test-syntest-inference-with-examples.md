1. fast-xml-parser

- Clone the fast-xml-parser Because the one in node is minified.
- Change webpack config in the project to "development"
- build
- I put the "fxp.full.js" in examples/ folder

2. tslib

- use `node_modules/tslib/tslib.js`

3. pako

- use `node_modules/pako/dist/pako.js`

4. sharp

- It ran but failed to infer anything (so the output is just any) because of syntest/lib/type/discovery/relation/RelationVisitor.js 339:21
- I also tried to build with `npx esbuild lib/sharp.js --bundle --platform=browser --outfile=sharp.bundle.js`

5. redux

- used `node_modules/redux/dist/redux.mjs`

6. jimp

- Go to node_modules/jimp/dist/browser (or cp to another dir for safety)
- `npx esbuild index.js --bundle --platform=neutral --outfile=jimp.browser.js`
- run syntest on the jimp.browser.js ~ 1887 line of schema
- I put one in examples/

7. jpeg-js

- cp the node_modules/jpeg-js/ to somewhere else 
- run this: `npx esbuild index.js --bundle --platform=neutral --outfile=jpeg-js.bundle.js`
- run syntest on the `jpeg-js.bundle.js`
- One in examples/

8. js-yaml

- use `node_modules/js-yaml/dist/js-yaml.js`

