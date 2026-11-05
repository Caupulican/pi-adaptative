import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { resolveSemanticUsageEntry } from "../../../../src/core/cost/usage-records.ts";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
} from "../../../../src/core/learning/owner-evidence-ledger.ts";
import type { KnowledgeCollectionOutcome } from "../../../../src/core/memory/knowledge-collector.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { createBarrier, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { runJourney1LongCollection } from "./journey-1-long-collection.ts";
import { ICM_INTAKE_JUDGMENTS, icmContinuousSettings, icmWaitForChatIdle, knowledgeJudgment } from "./shared.ts";

/** The session model's answers with System One off: a stated fact that was not a request to remember it. */
const JUDGED_STATED = {
	grounded: { value: true, confidence: 0.98 },
	basis: { selected: "explicit", confidence: 0.98 },
	requested: { value: false, confidence: 0.98 },
} as const;
const JUDGED_INFERRED = { ...JUDGED_STATED, basis: { selected: "inferred", confidence: 0.98 } } as const;

/**
 * Journey 1 follows automatic collection through the real root, idle lane, admission and restart. With System One
 * off the session model judges each candidate; inferred patterns and background forgetting wait for a calibrated engine.
 */
export async function runJourney1CollectionPhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-collection`;
	const autoLearn = { knowledgeIdleDelayMs: 1_000 };
	const settings = icmContinuousSettings("worker-c", { autoLearn, proactivity: { enabled: false } });
	const root = await world.createRootSession("root", {
		agentDir,
		settings,
		sessionManager: world.createSessionManager(agentDir),
	});
	const store = KnowledgeStore.open(agentDir);
	const tracks: string[] = [];
	for (let size = 1; size <= 4; size *= 2) {
		for (let first = 0; first + size <= 4; first += size) {
			const task =
				size === 1
					? `Compaction: compress message ${first} into`
					: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
			const track = `collection-compaction-${first}+${size}`;
			tracks.push(track);
			world.provider.enqueueTrack(
				track,
				"worker-c",
				(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
				{
					name: track,
					optional: true,
					reply: {
						content: [
							{ type: "text", text: "Owner context and acknowledgement; original words remain available." },
						],
					},
				},
			);
		}
	}
	const terminal = (session: AgentSession): Promise<KnowledgeCollectionOutcome> =>
		new Promise((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type !== "knowledge_collection") return;
				off();
				resolve(event);
			});
		});
	let reopened: Awaited<ReturnType<HarnessWorld["createRootSession"]>> | undefined;
	let disposed = false;
	try {
		world.systemOne.enterPhase("collection-owner", {});
		world.provider.enqueue("root", text("collection-owner-reply", "Understood."));
		await withDeadline(world.trace, "collection original owner input", root.session.prompt("I live in Recife."));
		await icmWaitForChatIdle(world, agentDir, 2, (records) => records.length === 2);
		const before = world.provider.requests.length;
		const original = getOwnerEvidenceSnapshots(
			root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]),
		).at(-1)!;
		expect(original.text).toBe("I live in Recife.");
		world.systemOne.enterPhase("collection-admission", {
			grounded: { kind: "noul", probability: 0.98 },
			basis: { kind: "choice", choice: "explicit", confidence: 0.98 },
			requested: { kind: "noul", probability: 0.02 },
		});
		const reached = createBarrier();
		world.provider.enqueue(
			"root",
			{
				name: "collection-submit",
				check: (request) => {
					expect(request.context.tools?.map((tool) => tool.name)).toEqual([
						"knowledge",
						"submit_knowledge_candidates",
					]);
					expect(JSON.stringify(request.context.messages)).toContain(original.sourceId);
					expect(JSON.stringify(request.context.messages)).toContain(original.text);
					reached.release();
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "collection-submit",
							name: "submit_knowledge_candidates",
							arguments: {
								complete: true,
								candidates: [
									{
										action: "remember",
										kind: "profile",
										scope: "global",
										subject: "owner",
										key: "home-city",
										text: "Lives in Recife.",
										evidence: [{ source: original.sourceId, quote: "I live in Recife" }],
									},
								],
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			...(world.systemOne.enabled
				? []
				: [
						knowledgeJudgment(
							"collection-judgment",
							"knowledge.admission",
							JUDGED_STATED,
							() => "I live in Recife",
						),
					]),
		);
		await withDeadline(world.trace, "collection idle armed", world.timers.whenArmed("knowledge-collection"));
		const ended = terminal(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		await withDeadline(world.trace, "collection reached extractor", reached.promise);
		expect(await withDeadline(world.trace, "collection committed", ended)).toMatchObject({
			handoff: { retained: true },
			status: "completed",
			sources: 1,
			applied: 1,
			held: 0,
		});
		expect(store.list({ project: "", role: "", audience: "owner" })).toMatchObject([
			{ text: "Lives in Recife.", basis: "explicit" },
		]);
		// The session-model judge is one more bounded request of the same operation; System One is not a provider request.
		const requestsPerJudgedSource = world.systemOne.enabled ? 1 : 2;
		expect(world.provider.requests.length - before, "submission terminates without a final model request").toBe(
			requestsPerJudgedSource,
		);
		const receipts = root.sessionManager.getEntries().flatMap((entry) => {
			const report = resolveSemanticUsageEntry(entry)?.report;
			return report?.route === "knowledge_collection" ? [report] : [];
		});
		expect(receipts, "every real collection request has one independently retained receipt").toHaveLength(
			requestsPerJudgedSource,
		);
		for (const receipt of receipts) expect(receipt.origin?.operationId).toMatch(/^knowledge-collection:/);

		world.systemOne.enterPhase("collection-pasted-owner", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue("root", {
			...text("collection-pasted-reply", "Understood."),
			check: (request) =>
				expect(JSON.stringify(request.context.messages), "continuous chat receives accepted knowledge").toContain(
					"Lives in Recife.",
				),
		});
		await withDeadline(
			world.trace,
			"collection pasted input",
			root.session.prompt("My colleague wrote:\n> I live in Paris.\nHello again."),
		);
		await icmWaitForChatIdle(world, agentDir, 4, (records) => records.length === 4);
		const pasted = getOwnerEvidenceSnapshots(
			root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]),
		).at(-1)!;
		expect(pasted.text).toContain("> I live in Paris.");
		world.systemOne.enterPhase("collection-pasted", {});
		const status = () => root.session.memoryOperator.getKnowledgeCollectionStatus();

		// An exhausted session allowance holds the new source before any request, and says so.
		const beforeCap = world.provider.requests.length;
		root.settingsManager.setAutoLearnSettings({ ...autoLearn, knowledgeSessionMaxUsd: 0 });
		await withDeadline(world.trace, "capped collection armed", world.timers.whenArmed("knowledge-collection"));
		const capped = terminal(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "capped collection held", capped)).toMatchObject({
			handoff: { retained: true },
			status: "held",
			sources: 1,
			applied: 0,
			rejected: 0,
			held: 1,
		});
		expect(world.provider.requests.length, "an exhausted allowance starts no request").toBe(beforeCap);
		expect(status(), "the owner sees why collection starts no requests").toMatchObject({
			state: "inactive",
			reason: "budget_exhausted",
			sessionMaxUsd: 0,
			engine: world.systemOne.enabled
				? { provenance: "native_calibrated" }
				: { id: "structured-llm", model: `${HARNESS_PROVIDER}/root`, provenance: "synthetic_self_report" },
			last: { status: "held", held: 1 },
		});

		// Restoring the allowance re-collects the held source: a quoted paste is shown text, never the owner's fact.
		const recife = store.list({ project: "", role: "", audience: "owner" })[0]!;
		world.provider.enqueue(
			"root",
			{
				name: "collection-pasted-submit",
				check: (request) => expect(JSON.stringify(request.context.messages)).toContain(pasted.sourceId),
				reply: {
					content: [
						{
							type: "toolCall",
							id: "collection-pasted-submit",
							name: "submit_knowledge_candidates",
							arguments: {
								complete: true,
								candidates: [
									{
										action: "remember",
										kind: "profile",
										scope: "global",
										subject: "owner",
										key: "home-city",
										text: "Lives in Paris.",
										evidence: [{ source: pasted.sourceId, quote: "I live in Paris" }],
									},
									// A self-reported judge holds what only a calibrated probability may admit in the background.
									...(world.systemOne.enabled
										? []
										: [
												{
													action: "remember",
													kind: "behavior",
													scope: "global",
													subject: "owner",
													key: "context-sharing",
													text: "Shares personal context before asking.",
													evidence: [
														{ source: pasted.sourceId, quote: "Hello again" },
														{ source: original.sourceId, quote: "I live in Recife" },
													],
												},
												{
													action: "forget",
													id: recife.id,
													expectedRevision: recife.revision,
													evidence: [{ source: pasted.sourceId, quote: "Hello again" }],
												},
											]),
								],
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			...(world.systemOne.enabled
				? []
				: [knowledgeJudgment("collection-inference", "knowledge.admission", JUDGED_INFERRED, () => "Hello again")]),
		);
		const beforePasted = world.provider.requests.length;
		root.settingsManager.setAutoLearnSettings(autoLearn);
		await withDeadline(world.trace, "pasted collection armed", world.timers.whenArmed("knowledge-collection"));
		const pastedEnded = terminal(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "pasted collection judged", pastedEnded)).toMatchObject({
			handoff: { retained: true },
			status: world.systemOne.enabled ? "completed" : "held",
			sources: 1,
			applied: 0,
			rejected: 1,
			held: world.systemOne.enabled ? 0 : 1,
		});
		// Only the inference reaches the judge: the shown quote is rejected and background forgetting held before it.
		expect(world.provider.requests.length - beforePasted).toBe(requestsPerJudgedSource);
		expect(
			store.list({ project: "", role: "", audience: "owner" }),
			"no pasted, inferred or forgotten change reaches knowledge",
		).toMatchObject([{ id: recife.id, text: "Lives in Recife.", revision: recife.revision }]);
		expect(status(), "a restored allowance reactivates collection").toMatchObject({ state: "active" });
		const file = root.sessionManager.getSessionFile()!;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		disposed = true;
		const beforeReopen = world.provider.requests.length;
		reopened = await world.createRootSession("root", {
			agentDir,
			settings,
			sessionManager: world.openSessionManager(file, agentDir),
		});
		await withDeadline(world.trace, "reopened collection armed", world.timers.whenArmed("knowledge-collection"));
		const replayEnded = terminal(reopened.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "reopened collection replay", replayEnded)).toMatchObject({
			handoff: { retained: true },
			status: "completed",
			sources: 0,
			applied: 0,
		});
		// The reopened session reads the same configuration, so a source held on it is not judged again either.
		expect(world.provider.requests.length, "processed original sources are not extracted again on restart").toBe(
			beforeReopen,
		);
		world.trace.mark("root", "knowledge.automatic-collection");
	} finally {
		store.close();
		if (!disposed) expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		if (reopened) expect(await world.disposeSessionInBody(reopened.session)).toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
	await runJourney1LongCollection(world);
}
