#!/usr/bin/env node
import { resolve } from "node:path";
import { loadHeadlessScenario, runScenario, ScenarioError } from "./drive-live.mjs";

const DEFAULT_WARMUP_RUNS = 1;

function percentile(sorted, fraction) {
	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function median(sorted) {
	return percentile(sorted, 0.5);
}

function summarize(label, root, samples) {
	const wall = samples.map((sample) => sample.wallMs).sort((a, b) => a - b);
	const rss = samples.map((sample) => sample.rssKb).sort((a, b) => a - b);
	const line = `${label} ${root}: n=${wall.length} wall median=${median(wall).toFixed(1)} ms p90=${percentile(wall, 0.9).toFixed(1)} ms min=${wall[0].toFixed(1)} ms max=${wall.at(-1).toFixed(1)} ms, peak RSS median=${(median(rss) / 1024).toFixed(1)} MB max=${(rss.at(-1) / 1024).toFixed(1)} MB`;
	return { line, median: median(wall) };
}

async function measure(scenario, root) {
	const result = await runScenario(scenario, { root });
	if (result.failures.length > 0) throw new ScenarioError(`run failed in ${root}: ${result.failures.join("; ")}`);
	return { wallMs: result.marks.lastAgentEnd, rssKb: result.peakRssKb ?? 0 };
}

async function main() {
	const argv = process.argv.slice(2);
	const warmupIndex = argv.indexOf("--warmup");
	const warmup = warmupIndex === -1 ? DEFAULT_WARMUP_RUNS : Number(argv.splice(warmupIndex, 2)[1]);
	const [rootA, rootB, scenarioPath, countText] = argv;
	const count = Number(countText);
	if (!rootA || !rootB || !scenarioPath || !Number.isInteger(count) || count < 1 || !Number.isInteger(warmup) || warmup < 0) {
		throw new ScenarioError("usage: perf-probe.mjs <checkout-a> <checkout-b> <scenario.json> <count> [--warmup <n>]");
	}
	const scenario = loadHeadlessScenario(scenarioPath);
	const roots = [resolve(rootA), resolve(rootB)];
	for (let i = 0; i < warmup; i++) for (const root of roots) await measure(scenario, root);

	const samples = [[], []];
	for (let i = 0; i < count; i++) {
		for (const side of [0, 1]) samples[side].push(await measure(scenario, roots[side]));
	}
	const a = summarize("A", roots[0], samples[0]);
	const b = summarize("B", roots[1], samples[1]);
	console.log(a.line);
	console.log(b.line);
	const delta = ((b.median - a.median) / a.median) * 100;
	console.log(`B vs A median wall time: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% (${warmup} warmup run(s) per side, interleaved A B)`);
}

main().catch((error) => {
	console.error(error instanceof ScenarioError ? `perf-probe: ${error.message}` : error);
	process.exit(1);
});
