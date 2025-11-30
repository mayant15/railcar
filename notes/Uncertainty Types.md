There could be a way here to slightly formalise our type system. Given a program, we could have a type-checker that gives the *probability* of the program type-checking.

A "type" could be a probability distribution over a domain of all types, `unknown` and `error`.

For some definition of `error`, we could propagate the probability of an `error`, and define the probability of the program type-checking equal to $1 - P[\textbf{error}]$.

We could also use these probabilities to rank choices during graph mutation, so that we generate graphs that have the highest probability of type-checking.