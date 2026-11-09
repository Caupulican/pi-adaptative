import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { resolveSemanticUsageEntry } from "../../../../src/core/cost/usage-records.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
} from "../../../../src/core/learning/owner-evidence-ledger.ts";
import type { KnowledgeCollectionOutcome } from "../../../../src/core/memory/knowledge-collector.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { KNOWLEDGE_COLLECTION_CUSTOM_TYPE } from "../../../../src/core/reflection-controller.ts";
import { parentInputOf, parentInputOriginalDetails } from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { createBarrier, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { runJourney1LongCollection } from "./journey-1-long-collection.ts";
import {
	ICM_INTAKE_JUDGMENTS,
	icmContinuousSettings,
	icmContinuousStore,
	icmReadContinuousRecords,
	icmWaitForChatIdle,
	knowledgeJudgment,
} from "./shared.ts";

/** The session model's answers with System One off: a stated fact that was not a request to remember it. */
const JUDGED_STATED = [
	{ id: "grounded", value: true, confidence: 0.98 },
	{ id: "basis", selected: "explicit", confidence: 0.98 },
	{ id: "requested", value: false, confidence: 0.98 },
] as const;
const JUDGED_INFERRED = [
	{ id: "grounded", value: true, confidence: 0.98 },
	{ id: "basis", selected: "inferred", confidence: 0.98 },
	{ id: "requested", value: false, confidence: 0.98 },
] as const;
/** A new attribute of the owner is not the live home-city fact. */
const JUDGED_DISTINCT_SLOT = [{ id: "same_0", value: false, confidence: 0.98 }] as const;
/** Every owner turn logs its words and the reply. */
const TURN_RECORDS = 2;
/** A consumed harness notice is logged once, as harness work, by the owner turn that carried it. */
const CARRIED_NOTICE_RECORDS = 1;
/** Owner and pasted turns, then the yielded turn that carries the capped pass's notice, then the busy turn. */
const YIELD_TURN_RECORDS = 3 * TURN_RECORDS + CARRIED_NOTICE_RECORDS;
const COLLECTION_RECORDS = YIELD_TURN_RECORDS + TURN_RECORDS;
/** Custom entries of one type in the session log; an idle collection pass adds none. */
const countCustom = (sessionManager: SessionManager, customType: string): number =>
	sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === customType).length;

/**
 * Journey 1 follows automatic collection through the real root, idle lane, admission and restart. With System One
 * off the session model judges each candidate; inferred patterns and background forgetting wait for a calibrated engine.
 * Owner input during an extraction yields the pass without aborting the paid request; its result is retained once.
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
	for (let size = 1; size <= COLLECTION_RECORDS; size *= 2) {
		for (let first = 0; first + size <= COLLECTION_RECORDS; first += size) {
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
	// Gates a failed assertion leaves closed are opened before the producers are joined.
	const gates: Array<() => void> = [];
	const gate = () => {
		const barrier = createBarrier();
		gates.push(barrier.release);
		return barrier;
	};
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
		const notices = () =>
			root.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === HARNESS_NOTICE_CUSTOM_TYPE);
		const noticeSaved = createBarrier();
		const stopNotice = root.sessionManager.onEntriesPersisted(() => {
			if (notices().length > 0) noticeSaved.release();
		});
		root.settingsManager.setAutoLearnSettings({ ...autoLearn, knowledgeSessionMaxUsd: 0 });
		// The harness tells the owner by itself, for their next turn. Saving it holds the foreground for a moment, which
		// re-arms the collection alarm, so the pass is armed only after the notice is saved.
		await withDeadline(world.trace, "capped collection notice saved", noticeSaved.promise);
		stopNotice();
		expect(
			notices().map((entry) => [parentInputOf(entry)?.metadata.mode, parentInputOriginalDetails(entry)]),
			"one notice names the bound that holds collection",
		).toEqual([
			["next-owner-turn", { kind: "knowledge-collection", reason: "budget_exhausted:session", generation: 0 }],
		]);
		expect(root.sessionManager.getPendingParentInputs("turn"), "the notice wakes no turn").toEqual([]);
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
		expect(notices(), "the held pass observes the same state and adds no notice").toHaveLength(1);
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

		// Owner input while an extraction is in flight yields the pass: the paid request is not aborted, its result is
		// retained, and the next pass admits it without buying the extraction again.
		// The owner's next turn carries the capped pass's notice; once consumed it is logged as harness work, never as the
		// owner's words.
		const [cappedNotice] = notices();
		if (cappedNotice?.type !== "custom_message" || typeof cappedNotice.content !== "string")
			throw new Error("The capped collection's notice is not a saved text message.");
		const cappedNoticeText = cappedNotice.content;
		const cappedNoticeDelivery = parentInputOf(cappedNotice)?.metadata.deliveryId;
		const ownerTurn = { ...ICM_INTAKE_JUDGMENTS, carries_0: { kind: "noul", probability: 0.02 } } as const;
		world.systemOne.enterPhase("collection-yield-owner", ownerTurn);
		world.provider.enqueue("root", {
			...text("collection-yield-reply", "Understood."),
			check: (request) =>
				expect(JSON.stringify(request.context.messages), "the owner's next turn carries the notice").toContain(
					JSON.stringify(cappedNoticeText).slice(1, -1),
				),
		});
		await withDeadline(world.trace, "collection yield input", root.session.prompt("I work in Lisbon."));
		expect(root.sessionManager.getPendingParentInputs(), "the owner's turn consumed the notice").toEqual([]);
		await icmWaitForChatIdle(world, agentDir, YIELD_TURN_RECORDS, (records) => records.length === YIELD_TURN_RECORDS);
		const carried = icmReadContinuousRecords(world, icmContinuousStore(agentDir)).filter(
			(record) => record.kind === "work",
		);
		expect(carried, "the consumed notice is logged once, as harness work").toHaveLength(CARRIED_NOTICE_RECORDS);
		expect(carried[0]?.text).toContain(`[Harness background delivery ${cappedNoticeDelivery};`);
		expect(carried[0]?.text).toContain(cappedNoticeText);
		const lisbon = getOwnerEvidenceSnapshots(
			root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]),
		).at(-1)!;
		expect(lisbon.text).toBe("I work in Lisbon.");
		world.systemOne.enterPhase("collection-yield-extraction", {});
		const extracting = gate();
		const extractionReached = createBarrier();
		let extractionSequence: number | undefined;
		world.provider.enqueue("root", {
			name: "collection-yield-submit",
			gate: extracting.promise,
			check: (request) => {
				expect(JSON.stringify(request.context.messages)).toContain(lisbon.sourceId);
				extractionSequence = request.sequence;
				extractionReached.release();
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "collection-yield-submit",
						name: "submit_knowledge_candidates",
						arguments: {
							complete: true,
							candidates: [
								{
									action: "remember",
									kind: "profile",
									scope: "global",
									subject: "owner",
									key: "work-city",
									text: "Works in Lisbon.",
									evidence: [{ source: lisbon.sourceId, quote: "I work in Lisbon" }],
								},
							],
						},
					},
				],
				stopReason: "toolUse",
			},
		});
		await withDeadline(world.trace, "yield collection armed", world.timers.whenArmed("knowledge-collection"));
		const yielded = terminal(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		await withDeadline(world.trace, "yield extraction in flight", extractionReached.promise);
		world.systemOne.enterPhase("collection-yield-busy-owner", ownerTurn);
		const replying = gate();
		const replyReached = createBarrier();
		world.provider.enqueue("root", {
			...text("collection-yield-busy-reply", "Understood."),
			gate: replying.promise,
			check: () => replyReached.release(),
		});
		const busy = root.session.prompt("Thanks, carry on.");
		await withDeadline(world.trace, "owner turn during extraction", replyReached.promise);
		extracting.release();
		expect(await withDeadline(world.trace, "yielded collection", yielded)).toMatchObject({
			handoff: { retained: true },
			status: "cancelled",
			sources: 1,
			applied: 0,
			rejected: 0,
			held: 0,
		});
		expect(
			world.provider.terminals.find((entry) => entry.sequence === extractionSequence),
			"owner input never aborts a paid extraction",
		).toMatchObject({ stopReason: "toolUse", requestAborted: false });
		expect(store.list({ project: "", role: "", audience: "owner" }), "a yielded pass applies nothing").toMatchObject([
			{ id: recife.id },
		]);
		replying.release();
		await withDeadline(world.trace, "owner turn after yield", busy);
		await icmWaitForChatIdle(world, agentDir, COLLECTION_RECORDS, (records) => records.length === COLLECTION_RECORDS);
		const thanks = getOwnerEvidenceSnapshots(
			root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]),
		).at(-1)!;
		expect(thanks.text).toBe("Thanks, carry on.");
		world.systemOne.enterPhase("collection-yield-resumed", {
			grounded: { kind: "noul", probability: 0.98 },
			basis: { kind: "choice", choice: "explicit", confidence: 0.98 },
			requested: { kind: "noul", probability: 0.02 },
			same_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue(
			"root",
			// The retained extraction is admitted first: the live home-city fact is the one slot its identity is judged against.
			...(world.systemOne.enabled
				? []
				: [
						knowledgeJudgment(
							"collection-yield-judgment",
							"knowledge.admission",
							JUDGED_STATED,
							() => "I work in Lisbon",
						),
						knowledgeJudgment(
							"collection-yield-identity",
							"knowledge.identity",
							JUDGED_DISTINCT_SLOT,
							() => "I work in Lisbon",
						),
					]),
			{
				name: "collection-yield-busy-submit",
				check: (request) => expect(JSON.stringify(request.context.messages)).toContain(thanks.sourceId),
				reply: {
					content: [
						{
							type: "toolCall",
							id: "collection-yield-busy-submit",
							name: "submit_knowledge_candidates",
							arguments: { complete: true, candidates: [] },
						},
					],
					stopReason: "toolUse",
				},
			},
		);
		const beforeResumed = world.provider.requests.length;
		await withDeadline(world.trace, "resumed collection armed", world.timers.whenArmed("knowledge-collection"));
		const resumed = terminal(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "resumed collection committed", resumed)).toMatchObject({
			handoff: { retained: true },
			status: "completed",
			sources: 2,
			applied: 1,
			rejected: 0,
			held: 0,
		});
		expect(
			world.provider.requests.length - beforeResumed,
			"the yielded extraction is reused: only its judgments and the new source's extraction are requested",
		).toBe(world.systemOne.enabled ? 1 : 3);
		expect(
			world.provider.reached.filter((step) => step.endsWith(":collection-yield-submit")),
			"the paid extraction is bought once",
		).toHaveLength(1);
		expect(
			store
				.list({ project: "", role: "", audience: "owner" })
				.map((record) => record.text)
				.sort(),
		).toEqual(["Lives in Recife.", "Works in Lisbon."]);
		expect(notices(), "a yielded or resumed pass is no state the owner is told about").toHaveLength(1);

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
		const entriesBefore = countCustom(reopened.sessionManager, KNOWLEDGE_COLLECTION_CUSTOM_TYPE);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		// The pass promise is the barrier: an idle pass emits no event, so the terminal event is not awaited here.
		await withDeadline(
			world.trace,
			"reopened collection replay",
			reopened.session.memoryOperator.knowledgeCollectionSettled(),
		);
		expect(
			reopened.session.memoryOperator.getKnowledgeCollectionStatus().lastIdlePass,
			"the replay found no new source",
		).toBeDefined();
		expect(
			countCustom(reopened.sessionManager, KNOWLEDGE_COLLECTION_CUSTOM_TYPE),
			"an idle pass writes no terminal entry",
		).toBe(entriesBefore);
		// The reopened session reads the same configuration, so a source held on it is not judged again either.
		expect(world.provider.requests.length, "processed original sources are not extracted again on restart").toBe(
			beforeReopen,
		);
		world.trace.mark("root", "knowledge.automatic-collection");
	} finally {
		for (const release of gates) release();
		store.close();
		if (!disposed) expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		if (reopened) expect(await world.disposeSessionInBody(reopened.session)).toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
	await runJourney1LongCollection(world);
}
