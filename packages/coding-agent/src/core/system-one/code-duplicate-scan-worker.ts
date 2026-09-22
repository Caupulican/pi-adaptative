/**
 * Scan worker: scores a range of arena units as probes against the whole shared arena and posts back
 * `[probe, candidate, callSimilarity, structuralSimilarity]` tuples. The arena arrives on
 * SharedArrayBuffers, so no worker copies it.
 */

import { parentPort, workerData } from "node:worker_threads";
import {
	type ArenaBuffers,
	arenaUnitFeatures,
	type ScoringParameters,
	ScoringScratch,
	scoreProbe,
} from "./code-unit-arena.ts";

interface ScanWorkerInput {
	readonly arena: ArenaBuffers;
	readonly parameters: ScoringParameters;
	readonly from: number;
	readonly to: number;
}

const input = workerData as ScanWorkerInput;
const scratch = new ScoringScratch(input.arena.unitCount);
const results: number[] = [];
for (let probe = input.from; probe < input.to; probe += 1)
	for (const candidate of scoreProbe(
		input.arena,
		arenaUnitFeatures(input.arena, probe),
		probe,
		input.parameters,
		scratch,
	))
		results.push(probe, candidate.unit, candidate.callSimilarity, candidate.structuralSimilarity);
const packed = new Float64Array(results);
parentPort?.postMessage(packed, [packed.buffer]);
