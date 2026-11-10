import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { journalSlotOf, readJournal } from "../../../../src/core/cost/semantic-usage-journal.ts";
import { createSessionManagerLedgerPort } from "../../../../src/core/cost/session-ledger-port.ts";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
} from "../../../../src/core/learning/owner-evidence-ledger.ts";
import type { KnowledgeCollectionOutcome } from "../../../../src/core/memory/knowledge-collector.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { KNOWLEDGE_COLLECTION_CUSTOM_TYPE } from "../../../../src/core/reflection-controller.ts";
import { runAsyncReleaseSteps } from "../../../../src/core/util/resource-release.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { isPlainRecord } from "../../../../src/kernel/utils/value-guards.ts";
import { createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { icmContinuousSettings, icmWaitForChatIdle } from "./shared.ts";

/** Custom entries of one type in the session log; an idle collection pass adds none. */
const countCustom = (sessionManager: SessionManager, customType: string): number =>
	sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === customType).length;

/** Each auxiliary store has exactly the original owner message and its acknowledgement. */
function registerCompactionTracks(world: HarnessWorld, prefix: string): string[] {
	return [
		"Compaction: compress message 0 into",
		"Compaction: compress message 1 into",
		"Compaction: merge lines 0+1 and 1+1,",
	].map((task, index) => {
		const name = `${prefix}-${index}`;
		world.provider.enqueueTrack(
			name,
			"worker-c",
			(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
			{
				...text(name, "Owner preferences and editor choice; original evidence is retained."),
				optional: true,
			},
		);
		return name;
	});
}

/** Part of journey 1: retained long-original work, whole-source qualifications and interrupted transport. */
export async function runJourney1LongCollection(world: HarnessWorld): Promise<void> {
	if (!world.systemOne.enabled) return;
	const agentDir = `${world.agentDir}-long-collection`;
	const base = icmContinuousSettings("worker-c", {
		proactivity: { enabled: false },
		autoLearn: { knowledgeIdleDelayMs: 1_000, knowledgeMaxUsd: 0.02, knowledgeSessionMaxUsd: 1 },
	});
	const compactTracks = registerCompactionTracks(world, "long-collection-compaction");
	let root = await world.createRootSession("root", {
		agentDir,
		settings: base,
		sessionManager: world.createSessionManager(agentDir),
	});
	const store = KnowledgeStore.open(agentDir);
	const release = createBarrier();
	let disposal: ReturnType<HarnessWorld["disposeSessionInBody"]> | undefined;
	let primary: { error: unknown } | undefined;
	let stopCancelled: (() => void) | undefined;
	const terminal = (session: AgentSession) =>
		new Promise<KnowledgeCollectionOutcome>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type === "knowledge_collection") {
					off();
					resolve(event);
				}
			});
		});
	try {
		const opening = "I use Emacs. ";
		const middle = "I prefer tabs only when offline. ";
		const prefix = opening + "Background context. ".repeat(450);
		const originalText =
			prefix.slice(0, 7_990) +
			middle +
			"Background context. ".repeat(500) +
			"I no longer use Emacs. My editor is Helix.";
		expect(originalText.length).toBeGreaterThan(16_000);
		world.systemOne.enterPhase("long-collection-owner", {});
		world.provider.enqueue("root", text("long-collection-owner", "Understood."));
		await withDeadline(world.trace, "long owner original", root.session.prompt(originalText));
		await icmWaitForChatIdle(world, agentDir, 2, (records) => records.length === 2);
		const original = getOwnerEvidenceSnapshots(
			root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]),
		).at(-1)!;
		expect(original.text).toBe(originalText);
		const candidate = (key: string, value: string, quote: string) => ({
			action: "remember",
			kind: "behavior",
			scope: "global",
			subject: "owner",
			key,
			text: value,
			evidence: [{ source: original.sourceId, quote }],
		});
		let firstExtractions = 0;
		const usage = { ...createEmptyUsage(), input: 16, output: 8, totalTokens: 24 };
		usage.cost.total = 0.02;
		world.provider.enqueue("root", {
			name: "long-collection-first-window",
			check: (request) => {
				firstExtractions++;
				expect(JSON.stringify(request.context.messages)).toContain(original.sourceId);
				expect(JSON.stringify(request.context.messages)).not.toContain("My editor is Helix");
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "long-first",
						name: "submit_knowledge_candidates",
						arguments: {
							complete: true,
							candidates: [
								candidate("editor", "Uses Emacs.", "I use Emacs"),
								candidate("indentation", "Prefers tabs only when offline.", "I prefer tabs only when offline"),
							],
						},
					},
				],
				stopReason: "toolUse",
				usage,
			},
		});
		world.systemOne.enterPhase("long-extraction-budget", {});
		await withDeadline(world.trace, "long budget armed", world.timers.whenArmed("knowledge-collection"));
		const budgetEnd = terminal(root.session);
		world.timers.advance("knowledge-collection", 1_000);
		expect(await withDeadline(world.trace, "long retained extraction budget hold", budgetEnd)).toMatchObject({
			status: "held",
			handoff: { retained: true },
			applied: 0,
			held: 1,
		});
		expect(firstExtractions).toBe(1);
		expect(store.list({ project: "", role: "", audience: "owner" })).toEqual([]);
		const file = root.sessionManager.getSessionFile()!;
		disposal = world.disposeSessionInBody(root.session);
		expect(await disposal).toBeUndefined();
		root = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.openSessionManager(file, agentDir),
			settings: { ...base, autoLearn: { ...base.autoLearn, knowledgeMaxUsd: 1 } },
		});
		disposal = undefined;
		const editor = { kind: "choice" as const, choice: "explicit", confidence: 0.98 };
		const tabs = { kind: "choice" as const, choice: "explicit", confidence: 0.98 };
		const inspected: number[] = [];
		world.systemOne.enterPhase(
			"long-whole-original",
			{
				relation_0: editor,
				relation_1: tabs,
				requested_0: { kind: "noul", probability: 0.02 },
				requested_1: { kind: "noul", probability: 0.02 },
			},
			{
				expect: (request) => {
					const state = request.state as { window?: { coreStart: number; text: string } };
					if (!state.window) throw new Error("Expected a whole-original grounding window");
					inspected.push(state.window.coreStart);
					editor.choice =
						state.window.coreStart === 0
							? "explicit"
							: state.window.coreStart === 8_000
								? "unrelated"
								: "conflict";
					tabs.choice = state.window.coreStart === 16_000 ? "unrelated" : "explicit";
					if (state.window.coreStart === 16_000) expect(state.window.text).toContain("I no longer use Emacs");
				},
			},
		);
		const reached = createBarrier();
		world.provider.enqueue("root", {
			...text("long-second-window-interrupted", "none"),
			check: () => reached.release(),
			gate: release.promise,
			ignoresAbort: true,
		});
		await withDeadline(world.trace, "long resume armed", world.timers.whenArmed("knowledge-collection"));
		const cancelledManager = root.sessionManager;
		// Disposal removes session listeners; the shutdown handoff is witnessed at its durable publication boundary.
		const cancelled = new Promise<unknown>((resolve) => {
			stopCancelled = cancelledManager.onEntriesPersisted((event) => {
				for (const id of event.entryIds) {
					const entry = cancelledManager.getEntry(id);
					if (
						entry?.type !== "custom" ||
						entry.customType !== KNOWLEDGE_COLLECTION_CUSTOM_TYPE ||
						!isPlainRecord(entry.data) ||
						!isPlainRecord(entry.data.outcome) ||
						entry.data.outcome.status !== "cancelled"
					)
						continue;
					stopCancelled?.();
					resolve({ data: entry.data, persisted: cancelledManager.isEntryPersisted(id) });
				}
			});
		});
		world.timers.advance("knowledge-collection", 1_000);
		await withDeadline(world.trace, "long second window reached", reached.promise);
		expect(inspected).toEqual([0, 8_000, 16_000]);
		expect(firstExtractions, "retained extraction is not paid again after reopen").toBe(1);
		const [learned] = store.list({ project: "", role: "", audience: "owner" });
		expect(learned).toMatchObject({ text: "Prefers tabs only when offline." });
		expect(store.list({ project: "", role: "", audience: "owner" })).toHaveLength(1);
		expect(
			store.list({ project: "", role: "", audience: "owner" }).some((record) => record.text === "Uses Emacs."),
		).toBe(false);
		const warningMark = world.warnings.length;
		disposal = world.disposeSessionInBody(root.session);
		expect(await withDeadline(world.trace, "long cancellation terminal", cancelled)).toMatchObject({
			data: { version: 1, sessionId: cancelledManager.getSessionId(), outcome: { status: "cancelled" } },
			persisted: true,
		});
		expect(await disposal).toBeUndefined();
		const cancelledSlot = journalSlotOf(createSessionManagerLedgerPort(cancelledManager).identity());
		expect(cancelledSlot).toBeDefined();
		const unresolved = readJournal(cancelledSlot!)?.unresolved;
		expect(unresolved).toHaveLength(1);
		expect(unresolved![0]).toMatchObject({
			provider: "harness-script",
			model: "root",
			route: "knowledge_collection",
			origin: { sessionId: cancelledManager.getSessionId() },
		});
		expect(
			world.warnings.slice(warningMark),
			"shutdown retains the gated request with explicit unknown usage",
		).toEqual([
			`Provider request ${unresolved![0]!.requestId} ended locally with usage still unknown; its original accounting identity is retained in the session journal.`,
			// The cancelled pass had already committed one fact: the owner is told of it as the pass ends.
			`Learned (behavior): Prefers tabs only when offline.  /knowledge show ${learned!.id.slice(0, 8)}`,
			"Usage handoff: 0 usage report(s) pending in the session journal, 0 not retained, 0 confirmed row(s) with a journal copy left, 0 unmatched journal(s), 1 request(s) with unknown usage; none is charged to another session.",
		]);
		world.warnings.splice(warningMark);
		release.release();
		await world.provider.waitForProducers();
		const requestsBefore = world.provider.requests.length;
		const judgmentsBefore = world.systemOne.decoded.length;
		root = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.openSessionManager(file, agentDir),
			settings: { ...base, autoLearn: { ...base.autoLearn, knowledgeMaxUsd: 1 } },
		});
		disposal = undefined;
		world.systemOne.enterPhase("long-unresolved-refuses-replay", {});
		await withDeadline(world.trace, "long interrupted reopen armed", world.timers.whenArmed("knowledge-collection"));
		const held = terminal(root.session);
		world.timers.advance("knowledge-collection", 1_000);
		expect(await withDeadline(world.trace, "long interrupted source stays held", held)).toMatchObject({
			status: "held",
			handoff: { retained: true },
			held: 1,
		});
		expect(world.provider.requests.length).toBe(requestsBefore);
		expect(world.systemOne.decoded.length, "retained grounding pairs are not paid again").toBe(judgmentsBefore);
		world.trace.mark("root", "knowledge.long-source-recovery");
	} catch (error) {
		primary = { error };
		throw error;
	} finally {
		release.release();
		stopCancelled?.();
		await runAsyncReleaseSteps(
			[
				async () => {
					disposal ??= world.disposeSessionInBody(root.session);
					expect(await disposal).toBeUndefined();
				},
				() => store.close(),
				async () => {
					await world.provider.waitForProducers();
					for (const track of compactTracks) world.provider.retireOptional(track);
				},
			],
			"Long collection failed and cleanup reported evidence",
			primary,
		);
	}
	await runCompletedLongCollection(world);
}

/** Same journey, successful control: a subdivided core and the final core both finish durably. */
async function runCompletedLongCollection(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-long-collection-complete`;
	const settings = icmContinuousSettings("worker-c", {
		proactivity: { enabled: false },
		autoLearn: { knowledgeIdleDelayMs: 1_000, knowledgeMaxUsd: 1, knowledgeSessionMaxUsd: 2 },
	});
	const compactTracks = registerCompactionTracks(world, "long-complete-compaction");
	let root = await world.createRootSession("root", {
		agentDir,
		settings,
		sessionManager: world.createSessionManager(agentDir),
	});
	const store = KnowledgeStore.open(agentDir);
	let disposal: ReturnType<HarnessWorld["disposeSessionInBody"]> | undefined;
	let primary: { error: unknown } | undefined;
	const ended = (session: AgentSession) =>
		new Promise<KnowledgeCollectionOutcome>((resolve) => {
			const off = session.subscribe((event) => {
				if (event.type === "knowledge_collection") {
					off();
					resolve(event);
				}
			});
		});
	try {
		const preferences = Array.from({ length: 34 }, (_, index) => {
			const number = index + 1;
			return {
				key: `workspace-${number}`,
				quote: `My standing preference for workspace ${number} is option ${number}`,
				text: `Prefers option ${number} in workspace ${number}.`,
			};
		});
		const firstHalf = preferences
			.slice(0, 17)
			.map((item) => `${item.quote}.`)
			.join(" ")
			.padEnd(4_000, " ");
		const secondHalf = preferences
			.slice(17)
			.map((item) => `${item.quote}.`)
			.join(" ")
			.padEnd(3_990, " ");
		const originalText =
			firstHalf +
			secondHalf +
			"I prefer tabs only when offline. " +
			"Background context. ".repeat(500) +
			"My editor is Helix.";
		world.systemOne.enterPhase("long-complete-owner", {});
		world.provider.enqueue("root", text("long-complete-owner", "Understood."));
		await withDeadline(world.trace, "complete long owner input", root.session.prompt(originalText));
		await icmWaitForChatIdle(world, agentDir, 2, (records) => records.length === 2);
		const original = getOwnerEvidenceSnapshots(
			root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]),
		).at(-1)!;
		expect(original.text).toBe(originalText);
		const change = (key: string, value: string, quote: string) => ({
			action: "remember",
			kind: "behavior",
			scope: "global",
			subject: "owner",
			key,
			text: value,
			evidence: [{ source: original.sourceId, quote }],
		});
		const boundaries: Array<[number, number]> = [];
		const submit = (
			label: string,
			start: number,
			end: number,
			complete: boolean,
			candidates: ReturnType<typeof change>[],
		) => {
			world.provider.enqueue("root", {
				name: label,
				check: (request) => {
					const messages = JSON.stringify(request.context.messages);
					expect(messages).toContain(original.sourceId);
					expect(messages).toContain(original.createdAt);
					expect(messages).toContain(JSON.stringify(`"coreStart":${start}`).slice(1, -1));
					expect(messages).toContain(JSON.stringify(`"coreEnd":${end}`).slice(1, -1));
					boundaries.push([start, end]);
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: label,
							name: "submit_knowledge_candidates",
							arguments: { complete, candidates },
						},
					],
					stopReason: "toolUse",
				},
			});
		};
		submit("long-complete-subdivide", 0, 8_000, false, []);
		submit(
			"long-complete-child-one",
			0,
			4_000,
			true,
			preferences.slice(0, 17).map((item) => change(item.key, item.text, item.quote)),
		);
		submit("long-complete-child-two", 4_000, 8_000, true, [
			...preferences.slice(17).map((item) => change(item.key, item.text, item.quote)),
			change("indentation", "Prefers tabs only when offline.", "I prefer tabs only when offline"),
		]);
		submit("long-complete-middle", 8_000, 16_000, true, []);
		submit("long-complete-final", 16_000, originalText.length, true, [
			change("editor", "Uses Helix.", "My editor is Helix"),
		]);
		const relations = Array.from({ length: 8 }, () => ({
			kind: "choice" as const,
			choice: "unrelated",
			confidence: 0.98,
		}));
		const inspected: Record<string, number[]> = {};
		world.systemOne.enterPhase(
			"long-complete-grounding",
			Object.fromEntries(relations.map((relation, index) => [`relation_${index}`, relation])),
			{
				families: { same_: { kind: "noul", probability: 0.02 }, requested_: { kind: "noul", probability: 0.02 } },
				expect: (request) => {
					const state = request.state as {
						window?: { coreStart: number; text: string };
						candidates?: Array<{ change: { key: string } }>;
					};
					if (!state.window) return; // The same production phase also resolves canonical identities.
					if (!state.candidates?.length) throw new Error("Expected candidates in window grounding");
					for (const [index, candidate] of state.candidates.entries()) {
						const key = candidate.change.key;
						inspected[key] ??= [];
						inspected[key].push(state.window.coreStart);
						relations[index]!.choice = key.startsWith("workspace-")
							? state.window.coreStart === 0
								? "explicit"
								: "unrelated"
							: key === "indentation"
								? state.window.coreStart === 16_000
									? "unrelated"
									: "explicit"
								: state.window.coreStart === 16_000
									? "explicit"
									: "unrelated";
						if (key === "editor" && state.window.coreStart === 16_000)
							expect(state.window.text).toContain("My editor is Helix");
					}
				},
			},
		);
		await withDeadline(world.trace, "complete long collection armed", world.timers.whenArmed("knowledge-collection"));
		const finished = ended(root.session);
		world.timers.advance("knowledge-collection", 1_000);
		expect(await withDeadline(world.trace, "complete long collection finished", finished)).toMatchObject({
			status: "completed",
			sources: 1,
			applied: 36,
			held: 0,
			handoff: { retained: true },
		});
		expect(boundaries).toEqual([
			[0, 8_000],
			[0, 4_000],
			[4_000, 8_000],
			[8_000, 16_000],
			[16_000, originalText.length],
		]);
		for (const key of [...preferences.map((item) => item.key), "indentation", "editor"])
			expect(inspected[key]).toEqual([0, 8_000, 16_000]);
		// The default page holds 20 rows; include every expected fact and one slot to expose unexpected extras.
		const records = store.list({ project: "", role: "", audience: "owner" }, { limit: preferences.length + 3 });
		expect(records.map((record) => record.text).sort()).toEqual(
			[...preferences.map((item) => item.text), "Prefers tabs only when offline.", "Uses Helix."].sort(),
		);
		expect(
			records.every(
				(record) =>
					record.lastEvidencedAt === original.createdAt &&
					record.citations.length === 1 &&
					record.citations[0]!.sourceId === original.sourceId,
			),
		).toBe(true);
		const file = root.sessionManager.getSessionFile()!;
		disposal = world.disposeSessionInBody(root.session);
		expect(await disposal).toBeUndefined();
		const before = world.provider.requests.length;
		root = await world.createRootSession("root", {
			agentDir,
			settings,
			sessionManager: world.openSessionManager(file, agentDir),
		});
		disposal = undefined;
		world.systemOne.enterPhase("long-complete-reopen", {});
		await withDeadline(world.trace, "complete long reopened armed", world.timers.whenArmed("knowledge-collection"));
		const entriesBefore = countCustom(root.sessionManager, KNOWLEDGE_COLLECTION_CUSTOM_TYPE);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		// The pass promise is the barrier: an idle pass emits no event, so the terminal event is not awaited here.
		await withDeadline(
			world.trace,
			"complete long reopened",
			root.session.memoryOperator.knowledgeCollectionSettled(),
		);
		expect(
			root.session.memoryOperator.getKnowledgeCollectionStatus().lastIdlePass,
			"the replay found no new source",
		).toBeDefined();
		expect(
			countCustom(root.sessionManager, KNOWLEDGE_COLLECTION_CUSTOM_TYPE),
			"an idle pass writes no terminal entry",
		).toBe(entriesBefore);
		expect(world.provider.requests.length).toBe(before);
		world.trace.mark("root", "knowledge.long-source-complete");
	} catch (error) {
		primary = { error };
		throw error;
	} finally {
		await runAsyncReleaseSteps(
			[
				async () => {
					disposal ??= world.disposeSessionInBody(root.session);
					expect(await disposal).toBeUndefined();
				},
				() => store.close(),
				async () => {
					await world.provider.waitForProducers();
					for (const track of compactTracks) world.provider.retireOptional(track);
				},
			],
			"Completed collection failed and cleanup reported evidence",
			primary,
		);
	}
}
