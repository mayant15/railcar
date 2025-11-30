There's a lightweight web app in `packages/reporter` to monitor fuzzing campaigns. It is not exposed to end users yet.

The web app scrapes fuzzer status every 15 seconds (libAFL client heartbeat) and pushes updates to a client UI.