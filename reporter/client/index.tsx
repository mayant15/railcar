import {render} from "preact"
import {type Signal, signal} from "@preact/signals"

import { type AppState, createAppState } from "./state.ts"
import ProjectInfo from "./project-info.tsx"

const root = document.getElementById("root")
if (!root) {
  throw Error("Root element not found")
}

const state = signal(createAppState())

type AppProps = {
  state: Signal<AppState>
}

function App({state}: AppProps) {
  const projects = state.value.projects
  return (
    <>
      <h1>Railcar Status</h1>
      {projects.length === 0
        ? <p>No results yet.</p>
        : projects.map(project => <ProjectInfo project={project} />)}
    </>
  )
}

render(<App state={state} />, root)
