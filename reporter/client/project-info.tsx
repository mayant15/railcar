import type {ProjectInfo} from "./state.ts"

type ProjectInfoProps = {
  project: ProjectInfo
}

export default function ProjectInfo({project}: ProjectInfoProps) {
  return (
    <div>
      <h3>{project.name}</h3>
    </div>
  )
}
