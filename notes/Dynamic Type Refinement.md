Given a schema with [[Uncertainty Types|uncertain function signatures]], we could refine distributions with dynamic feedback. 

For an API sequence, save dynamic types for arguments and return types for *successful* prefixes (all API calls before the first error was thrown). Use these types to refine probability distributions.

This might require more "dynamic" IPC methods, the [[Shared Memory|current shared memory]] setup is fixed-size.

We should also move the schema into state, instead of keeping it with inputs.