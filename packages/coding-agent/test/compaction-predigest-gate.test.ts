import { describe, expect, it } from "vitest";
import type { CurationComplete } from "../src/core/context/brain-curator.ts";
import { FitnessStore } from "../src/core/models/fitness-store.ts";
import type { ModelFitnessReport } from "../src/core/research/model-fitness.ts";
import { createHarness } from "./suite/harness.ts";

/**
 * T2: the compaction pre-digest gate (agent-session `_buildCompactionPreDigest`) requires — on top of a
 * digest-fit curation model — a RUNTIME reliability proof: the curator must have run >= 5 jobs this
 * session with a parse-failure rate <= 5% before it is trusted to pre-digest compaction input. Below
 * that bar it returns undefined (verbatim compaction) with skip reason
 * curation_predigest_reliability_unproven; at/above it, the pre-digest function is used.
 */

type PreDigestSession = {
	settingsManager: { setContextCurationSettings: (s: object) => void };
	// _brainCurator + _lastPreDigestSkipReason moved to ContextPipeline (god-file decomposition);
	// _buildCompactionPreDigest stays on AgentSession as a one-line delegation to the pipeline.
	_pipeline: {
		_brainCurator: {
			enqueue: (job: { kind: "stub_digest"; key: string; content: string }) => void;
			drain: (opts: { maxJobs: number; complete: CurationComplete }) => Promise<unknown>;
			telemetry: () => { jobsRun: number; parseFailures: number };
		};
		_lastPreDigestSkipReason: string | undefined;
	};
	_buildCompactionPreDigest: () => ((text: string, signal?: AbortSignal) => Promise<string>) | undefined;
};

const scripted = (replies: string[]): CurationComplete => {
	let call = 0;
	return async () => ({ text: replies[call++] ?? "", costUsd: 0, stopReason: "stop" });
};

const digestFitReport = (): ModelFitnessReport => {
	const lane = { succeeded: 3, total: 3, outcomes: [], meanMs: 10 };
	return {
		trials: 3,
		research: { ...lane },
		worker: { ...lane },
		search: { ...lane },
		toolCall: { ...lane },
		digest: { succeeded: 2, total: 3, outcomes: [], meanMs: 10 },
		judge: {
			parsed: 0,
			planningElevated: 0,
			planningTotal: 0,
			trivialCheap: 0,
			trivialTotal: 0,
			total: 0,
			outcomes: [],
			meanMs: 0,
		},
		totalCostUsd: 0,
	};
};

const makeHarness = async () => {
	const harness = await createHarness({ models: [{ id: "cur" }] });
	// Digest-fit curation model on THIS host, so the model gate passes and only the reliability gate
	// is under test.
	FitnessStore.forAgentDir(harness.tempDir).save("faux/cur", digestFitReport());
	harness.settingsManager.setContextCurationSettings({ enabled: true, model: "faux/cur" });
	return harness;
};

/** Drive the curator's telemetry directly (bypassing the session model) to a chosen jobs/failures mix. */
const runCuratorJobs = async (session: PreDigestSession, replies: string[]) => {
	for (let i = 0; i < replies.length; i++) {
		session._pipeline._brainCurator.enqueue({ kind: "stub_digest", key: `k${i}`, content: `chunk ${i}` });
	}
	await session._pipeline._brainCurator.drain({ maxJobs: replies.length, complete: scripted(replies) });
};

describe("compaction pre-digest reliability gate (surface 3)", () => {
	it("with < 5 jobs run: refuses the pre-digest (verbatim compaction) with the unproven skip reason", async () => {
		const harness = await makeHarness();
		try {
			const session = harness.session as unknown as PreDigestSession;
			// Fresh session: jobsRun is 0, below the 5-job floor.
			expect(session._pipeline._brainCurator.telemetry().jobsRun).toBe(0);
			expect(session._buildCompactionPreDigest()).toBeUndefined();
			expect(session._pipeline._lastPreDigestSkipReason).toBe("curation_predigest_reliability_unproven");
		} finally {
			harness.cleanup();
		}
	});

	it("with >= 5 jobs but a parse-failure rate above 5%: still refuses (unproven)", async () => {
		const harness = await makeHarness();
		try {
			const session = harness.session as unknown as PreDigestSession;
			// 5 jobs, 1 unparseable reply -> 20% failure rate, above the 5% ceiling.
			await runCuratorJobs(session, [
				'{"digest":"a"}',
				'{"digest":"b"}',
				'{"digest":"c"}',
				'{"digest":"d"}',
				"not json",
			]);
			const telemetry = session._pipeline._brainCurator.telemetry();
			expect(telemetry.jobsRun).toBe(5);
			expect(telemetry.parseFailures).toBe(1);
			expect(session._buildCompactionPreDigest()).toBeUndefined();
			expect(session._pipeline._lastPreDigestSkipReason).toBe("curation_predigest_reliability_unproven");
		} finally {
			harness.cleanup();
		}
	});

	it("with >= 5 jobs and a parse-failure rate <= 5%: uses the pre-digest and clears the skip reason", async () => {
		const harness = await makeHarness();
		try {
			const session = harness.session as unknown as PreDigestSession;
			await runCuratorJobs(session, [
				'{"digest":"a"}',
				'{"digest":"b"}',
				'{"digest":"c"}',
				'{"digest":"d"}',
				'{"digest":"e"}',
			]);
			const telemetry = session._pipeline._brainCurator.telemetry();
			expect(telemetry.jobsRun).toBe(5);
			expect(telemetry.parseFailures).toBe(0);
			expect(typeof session._buildCompactionPreDigest()).toBe("function");
			expect(session._pipeline._lastPreDigestSkipReason).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});
