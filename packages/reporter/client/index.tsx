/**
 * SPDX-FileCopyrightText: Mayant Mukul
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { render } from "preact";
import { type Signal, signal } from "@preact/signals";

import FuzzerGroupSummary from "./fuzzer-group-summary.tsx";
import type { GroupedFuzzerInfo } from "../api.ts";

const POLL_DURATION_SECS = 15;

type AppState = GroupedFuzzerInfo[];

async function updateAppState(state: Signal<AppState>) {
	const response = await fetch("/api/projects");
	state.value = await response.json();
}

type AppProps = {
	state: Signal<AppState>;
};

function App({ state }: AppProps) {
	const projects = state.value;
	return (
		<>
			<h1>Railcar Status</h1>
			{projects.length === 0 ? (
				<p>No results yet.</p>
			) : (
				projects.map((info) => <FuzzerGroupSummary {...info} />)
			)}
		</>
	);
}

function main() {
	// set up poll for app state
	// =========================

	const state = signal([]);

	updateAppState(state);
	setInterval(() => {
		updateAppState(state);
	}, POLL_DURATION_SECS * 1000);

	// render the UI
	// =============

	const root = document.getElementById("root");
	if (!root) {
		throw Error("Root element not found");
	}

	render(<App state={state} />, root);
}

main();
