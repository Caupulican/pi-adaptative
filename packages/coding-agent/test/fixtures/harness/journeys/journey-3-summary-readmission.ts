import { expect } from "vitest";
import { TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION } from "../../../../src/core/memory/transcript-summary-admission.ts";
import {
	nodeDisagreesWithEntry,
	TranscriptSummaryStore,
} from "../../../../src/core/memory/transcript-summary-store.ts";
import { getDirectoryResourceProfileInfo } from "../../../../src/core/settings/settings-rules.ts";
import { HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, type ScriptedJudgment, withDeadline } from "../session-fixture.ts";
import { hierarchyOf, loadSummaries, summaryJudgeRequests } from "./journey-3-summary-recovery.ts";

/** Model summaries the scripted provider answered so far (the hierarchy's summarizer system prompt). */
function summarizerRequestCount(world: HarnessWorld): number {
	return world.provider.requests.filter(
		(request) => request.context.systemPrompt?.includes("You write compact factual summaries") === true,
	).length;
}

/**
 * The pre-contract state of an accepted model summary: the node keeps its text, span and table entry, but carries no
 * admission record and its entry no admission digest. Written with the store's own writers after the session that
 * accepted it is disposed, so no coordinator holds the store.
 */
async function forgetAdmissionRecord(store: TranscriptSummaryStore, nodeId: string): Promise<void> {
	const state = await store.load();
	if (!("nodes" in state) || state.manifest === undefined) throw new Error(`${nodeId}: summary store unavailable`);
	const node = state.nodes.get(nodeId);
	const entry = state.manifest.acceptedNodes[nodeId];
	if (node === undefined || entry === undefined) throw new Error(`${nodeId}: the accepted node is not in the store`);
	const unadmitted = { ...node };
	delete unadmitted.admission;
	await store.writeNodeFile(unadmitted);
	const unmarked = { ...entry };
	delete unmarked.admissionDigest;
	await store.patchManifest(state.manifest, {
		revision: state.manifest.revision + 1,
		acceptedNodes: { set: { [nodeId]: unmarked } },
	});
}

/**
 * Re-admission of an accepted summary that predates the admission contract (a model summary with no admission record).
 * The coordinator finds it on start, judges its exact text once with System One, and settles the admission under the
 * current contract. Nothing is summarized again, and the judgment is not a reused verdict.
 */
export async function runJourney3ReadmissionLeg(
	world: HarnessWorld,
	intakeJudgments: Readonly<Record<string, ScriptedJudgment>>,
): Promise<void> {
	const label = "h5-summary-readmission";
	const trace = world.trace;
	const agentDir = `${world.agentDir}-${label}`;
	const manager = world.createSessionManager(agentDir);
	const seed = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	world.systemOne.enterPhase(`${label}-seed`, intakeJudgments);
	// The same canonical captures as the retention leg: the last one seals them into one admitted leaf.
	for (let index = 1; index <= 4; index++) {
		world.provider.enqueue("root", text(`${label}-seed-${index}`, "Alpha remains unchanged."));
		await withDeadline(
			trace,
			`${label}: canonical seed turn ${index}`,
			seed.session.prompt("Keep alpha unchanged. ".repeat(6).trim()),
		);
	}
	expect(await world.disposeSessionInBody(seed.session)).toBeUndefined();

	const summaryText = "The owner asked to keep alpha unchanged. Pi acknowledged it each time.";
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			contextPolicy: {
				memory: {
					enabled: true,
					includeInPrompt: false,
					history: {
						hierarchy: true,
						summaryModel: `${HARNESS_PROVIDER}/worker-c`,
						allowExternalSummaryEgress: true,
						allowExternalAdmissionEgress: true,
						maxConcurrentSummaries: 1,
					},
				},
			},
		},
	});
	const session = created.session;
	const projectId = getDirectoryResourceProfileInfo(HARNESS_PROJECT_CWD, agentDir).hash.toLowerCase();
	const store = new TranscriptSummaryStore({ agentDir, projectId });
	await withDeadline(
		trace,
		`${label}: history hierarchy starts`,
		world.io.waitForMutation(() => hierarchyOf(session)?.state === "running"),
	);
	world.provider.enqueueTrack(
		`${label}-history-hierarchy`,
		"worker-c",
		(request) => request.context.systemPrompt?.includes("You write compact factual summaries") === true,
		text(`${label}-history-hierarchy`, summaryText),
	);
	world.provider.enqueue("root", {
		...text(`${label}-seal-history`, "Ready to continue."),
		check: () =>
			world.systemOne.enterPhase(`${label}-history-judge`, {
				summary_supported: { kind: "noul", probability: 0.97 },
				owner_constraints_preserved: { kind: "noul", probability: 0.97 },
			}),
	});
	await withDeadline(trace, `${label}: seal history through owner turn`, session.prompt("Continue."));
	await withDeadline(trace, `${label}: sealing turn idle`, session.waitForForegroundIdle());
	await withDeadline(
		trace,
		`${label}: the summary is admitted`,
		world.io.waitForMutation(() => {
			const hierarchy = hierarchyOf(session);
			return hierarchy?.admission?.judgments.accepted === 1 && hierarchy.acceptedNodes === 1;
		}),
	);
	const sealed = await loadSummaries(store, `${label}: admitted`);
	expect(sealed.models.map((model) => model.text)).toEqual([summaryText]);
	const node = sealed.models[0]!;
	expect(await world.disposeSessionInBody(session)).toBeUndefined();

	await forgetAdmissionRecord(store, node.id);
	const unadmitted = await loadSummaries(store, `${label}: admission record removed`);
	expect(unadmitted.models.map((model) => model.admission)).toEqual([undefined]);
	expect(unadmitted.manifest.acceptedNodes[node.id]?.admissionDigest).toBeUndefined();

	world.systemOne.enterPhase(`${label}-readmit`, {
		summary_supported: { kind: "noul", probability: 0.97 },
		owner_constraints_preserved: { kind: "noul", probability: 0.97 },
	});
	const judgeRequests = summaryJudgeRequests(world);
	const summarizerRequests = summarizerRequestCount(world);
	const reopened = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			contextPolicy: {
				memory: {
					enabled: true,
					includeInPrompt: false,
					history: {
						hierarchy: true,
						summaryModel: `${HARNESS_PROVIDER}/worker-c`,
						allowExternalSummaryEgress: true,
						allowExternalAdmissionEgress: true,
						maxConcurrentSummaries: 1,
					},
				},
			},
		},
	});
	const readmitting = reopened.session;
	await withDeadline(
		trace,
		`${label}: the coordinator re-admits the summary`,
		world.io.waitForMutation(() => {
			const hierarchy = hierarchyOf(readmitting);
			return hierarchy?.admission?.judgments.accepted === 1 && hierarchy.admission.unapprovedNodes === 0;
		}),
	);
	const readmitted = await loadSummaries(store, `${label}: re-admitted`);
	expect(
		readmitted.models.map((model) => ({
			id: model.id,
			text: model.text,
			admission: model.admission?.disposition,
			contract: model.admission?.contractVersion,
			judged: model.admission?.judged,
		})),
	).toEqual([
		{
			id: node.id,
			text: summaryText,
			admission: "accepted",
			contract: TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION,
			judged: ["support", "constraints"],
		},
	]);
	const entry = readmitted.manifest.acceptedNodes[node.id];
	if (entry === undefined) throw new Error(`${label}: the re-admitted node has no accepted entry`);
	expect(nodeDisagreesWithEntry(readmitted.models[0]!, entry), "the entry names the new admission").toBe(false);
	expect(hierarchyOf(readmitting)?.admission?.reused, "the judgment is asked again, not reused").toBe(0);
	expect(summaryJudgeRequests(world), "one admission judgment for the node").toBe(judgeRequests + 1);
	expect(summarizerRequestCount(world), "no summarizer call").toBe(summarizerRequests);
	expect(await world.disposeSessionInBody(readmitting)).toBeUndefined();
	trace.mark("root", label);
}
