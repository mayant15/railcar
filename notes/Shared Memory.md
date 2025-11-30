We have a single, fixed-size shared memory buffer between the Node and Rust processes. All observers use different offsets into this buffer to save their data.

Maybe we should let each observer set up its own shared memory?