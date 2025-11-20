/**
 * SPDX-FileCopyrightText: Mayant Mukul
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Routes for the server. Use data from store to fulfill requests.
 */

import type { Store } from "./store.ts";
import type { ProjectsResponse, GroupedFuzzerInfo } from "../api.ts";

export function projects(store: Store): Response {
    const response = makeResponsePayload(store);
    return new Response(JSON.stringify(response), {
        headers: {
            "Content-Type": "application/json",
        },
    });
}

function makeResponsePayload(store: Store): ProjectsResponse {
    const groups: Record<string, GroupedFuzzerInfo> = {};

    for (const fuzzer of store.fuzzers) {
        const name = getFuzzerName(fuzzer.config.labels, fuzzer.pid);
        if (!groups[name]) {
            groups[name] = {
                name,
                data: [],
            };
        }
        groups[name].data.push({
            name: fuzzer.config.mode,
            crashes: fuzzer.counters.crashes,
            corpus: fuzzer.counters.corpus,
            status: fuzzer.status,
            coverage: makeCoverage(fuzzer.coverage),
        });
    }

    return Object.values(groups);
}

function getFuzzerName(labels: string[], pid: number): string {
    if (labels.length > 0) return labels[0];
    else return `fuzzer_${pid}`;
}

function makeCoverage(coverage: [number, number][]): [number, number][] {
    if (coverage.length === 0) return [];

    // if we're over an hour:
    // - resample to about one point per minute
    // - convert x-axis into hours
    let samples = coverage;
    if (coverage[coverage.length - 1][0] - coverage[0][0] > 60 * 60) {
        samples = [];
        for (let i = 0; i < coverage.length; i += 4) {
            const [x, y] = coverage[i];
            samples.push([x / (60 * 60), y]);
        }
    }

    return samples.map(([x, y]) => [x, y * 100]); // percentage
}
