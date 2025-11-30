Feedback based on the number of APIs that run without error in a given API sequence.

This right now is a quadratic curve that peaks at (10,10)
$$
\textrm{progress} = 100 - ((s - 10)^2 + (t - 10)^2)
$$
$s$ is a the number of successful API calls and $t$ is the total length of the sequence.

This metric probably needs more work. We do not know how to prioritize API sequences.