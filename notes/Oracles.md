Railcar allows custom oracles, a JS function that receives a thrown object and decides if it is a bug or not. The default oracle works like this:
1. An `AssertionError` is always a bug
2. A `TypeError` or `RangeError` is never a bug
3. Check a user-specified list of "false positive" error messages

To evaluate fuzzer performance, we can look at the number of *valid* executions, as deemed by this oracle. Either API sequences that do not crash or sequences that are genuine bugs according to this oracle.