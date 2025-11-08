import Chart from "chart.js/auto"
import type {ProjectsResponse} from "./server.ts"

type ProjectInfo = ProjectsResponse[keyof ProjectsResponse]

async function getProjects(): Promise<ProjectsResponse> {
    const response = await fetch('/api/projects')
    return response.json()
}

async function updateProjects(charts: Record<string, Chart>, projects: ProjectsResponse) {
    const main = document.getElementById("main")!
    for (const [name, info] of Object.entries(projects)) {
        let container = document.getElementById(`project-container-${name}`)
        if (!container) {
            container = createProjectContainer(main, name)
        }
        updateProjectContainer(container, info, charts)
    }
}

function createProjectContainer(parent: HTMLElement, name: string) {
    const container = parent.appendChild(document.createElement("div"))
    container.id = `project-container-${name}`
    
    container.innerHTML = `
<h3>${name}</h3>
<span class="mode"></span><br />
<span class="corpus"></span><br />
<span class="crashes"></span>
<div class="coverage">
 <p>No coverage data yet.</p>
</div>
    `

    return container;
}

async function updateProjectContainer(container: HTMLElement, info: ProjectInfo, charts: Record<string, Chart>) {
    container.querySelector(".mode")!.textContent = `Running in ${info.mode} mode.`
    container.querySelector(".corpus")!.textContent = `Corpus: ${info.corpus}`
    container.querySelector(".crashes")!.textContent = `Crashes: ${info.crashes}`

    if (info.coverage === null) return

    const xdata = info.coverage.map(row => row[0])
    const ydata = info.coverage.map(row => row[1])
    
    const chart = charts[info.name]
    if (chart) {
        chart.data.labels = xdata
        chart.data.datasets[0].data = ydata
        chart.update()
    } else {
        const canvas = container.appendChild(document.createElement("canvas"))
        container.removeChild(container.querySelector(".coverage")!)
        charts[info.name] = new Chart(canvas, {
            type: 'line',
            options: { animation: false },
            data: {
                labels: xdata,
                datasets: [{ label: 'Coverage %', data: ydata }]
            }
        }
        )
    }
}

async function poll(charts: Record<string, Chart>) {
    const projects = await getProjects()
    await updateProjects(charts, projects)
}

async function main() {
    const charts: Record<string, Chart> = {}
    poll(charts)

    setInterval(async () => {
        poll(charts)
    }, 15 * 1000)
}

await main()
