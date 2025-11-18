/**
 * SPDX-FileCopyrightText: Mayant Mukul
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {useRef, useEffect} from "preact/hooks"
import {type GroupedFuzzerInfo, type GroupedFuzzerInfoData, StatusCode} from "../api.ts"
import Chart from "chart.js/auto"

type FuzzerGroupSummaryProps = GroupedFuzzerInfo

export default function FuzzerGroupSummary({name, data}: FuzzerGroupSummaryProps) {
  const canvas  = useRef<HTMLCanvasElement | null>(null)
  const chart = useRef<Chart | null>(null)

  useEffect(() => {
    const datasets: Array<{label: string, data: [number, number][]}> = []
    for (const {coverage, name} of data) {
      datasets.push({
        label: name,
        data: coverage
      })
    }

    if (canvas.current === null) return

    if (chart.current === null) {
      chart.current = new Chart(canvas.current, {
        type: "line",
        options: {
          animation: false,
          scales: {
            x: {
              type: "linear"
            }
          }
        },
        data: { datasets }
      })
    } else {
      chart.current.data.datasets = datasets
      chart.current.update()
    }
  }, [data])

  return (
    <div>
      <h3>{name}</h3>
      {data.map(d => <FuzzerStatusLine {...d} />)}
      <canvas ref={canvas}></canvas>
    </div>
  )
}

function FuzzerStatusLine({name, status, corpus, crashes}: GroupedFuzzerInfoData) {
  return (
    <div>
      <span>Mode: {name}</span><br />
      <span>Status: {StatusCode[status]}</span><br />
      <span>Corpus: {corpus}</span><br />
      <span>Crashes: {crashes}</span><br />
    </div>
  )
}
