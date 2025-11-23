# Devtools

## Reporter

Railcar comes with a lightweight web app to monitor a fuzzing campaign. So far this is not distributed
to end users and is only available in the source repo. The web app scrapes fuzzer status every 15
seconds (libAFL client heartbeat) and pushes updates to a client UI.
