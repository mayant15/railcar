# Performance

## Profiling

Uses [samply](https://github.com/mstange/samply). Grant permissions with
```bash
echo '-1' | sudo tee /proc/sys/kernel/perf_event_paranoid
```

Then run with
```bash
samply record ./target/release/railcar [args...]
```

For fast-xml-parser:
- **API sequences** go into a heavy `Backtrace::new` on `load_input`, do not know why yet. Excluding
that, mutations take about 64% of time, and execution takes about 32%. About half of that mutation
cost is completion.
- **Graph** mutations take about 97% of time.
