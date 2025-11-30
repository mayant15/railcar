`mise dev` installs some development tools, including the [samply](https://github.com/mstange/samply) profiler.

Grant permissions with
```bash
echo '-1' | sudo tee /proc/sys/kernel/perf_event_paranoid
```

Then run with
```bash
samply record ./target/release/railcar [args...]
```

`samply` generates a Firefox-compatible trace.