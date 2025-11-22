# Feedback

## Schema Mutations

Before/after removing schema mutations. Seems like schema mutations hurt performance.

```
9437125294854ff6f783da506b43ea6cd499c467 chore: autoformat
Ran on mayantm
Timeout: 300 seconds

iter_0 seed: 24191
iter_1 seed: 34310
iter_2 seed: 99862
                        coverage  change
project          mode
sharp            graph    12.31%  20.85%
turf             graph     2.91%  15.52%
d3               graph     7.76%  11.22%
lit              graph    20.92%   9.86%
js-yaml          graph    56.06%   8.65%
fast-xml-parser  graph    23.87%   8.21%
canvg            graph     8.21%   5.00%
jimp             graph     7.56%   3.75%
lodash           graph    42.54%   1.85%
promise-polyfill graph    56.63%   1.83%
xml2js           graph    38.57%   1.35%
jpeg-js          graph    16.86%   0.00%
ua-parser-js     graph    28.51%   0.00%
protobufjs       graph     8.33%  -1.38%
tslib            graph    44.98%  -2.91%
redux            graph    35.74%  -4.29%
pako             graph    33.15%  -6.22%
xmldom           graph     4.39%  -7.98%
angular          graph     1.55%     NaN
```

## API Progress Feedback
Save input if it is more progress than its own pre-mutation version or more progress globally?

