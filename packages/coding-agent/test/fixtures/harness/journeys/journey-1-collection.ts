import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { resolveSemanticUsageEntry } from "../../../../src/core/cost/usage-records.ts";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
} from "../../../../src/core/learning/owner-evidence-ledger.ts";
import type { KnowledgeCollectionOutcome } from "../../../../src/core/memory/knowledge-collector.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, icmContinuousSettings, icmWaitForChatIdle } from "./shared.ts";

/** Journey 1 follows automatic collection through the real root, idle lane, admission and restart. */
export async function runJourney1CollectionPhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-collection`;
	const settings = icmContinuousSettings("worker-c", {
		autoLearn: { knowledgeIdleDelayMs: 1_000 },
		proactivity: { enabled: false },
	});
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
		if (!world.systemOne.enabled) {
			expect(world.timers.armedDelays("knowledge-collection"), "no extraction without an admission engine").toEqual(
				[],
			);
			expect(store.list({ project: "", role: "", audience: "owner" })).toEqual([]);
			return;
		}
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
		world.provider.enqueue("root", {
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
		});
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
		expect(world.provider.requests.length - before, "submission terminates without a final model request").toBe(1);
		const receipts = root.sessionManager.getEntries().flatMap((entry) => {
			const report = resolveSemanticUsageEntry(entry)?.report;
			return report?.route === "knowledge_collection" ? [report] : [];
		});
		expect(receipts, "the real extraction has one independently retained receipt").toHaveLength(1);
		expect(receipts[0]?.origin?.operationId).toMatch(/^knowledge-collection:/);

		world.systemOne.enterPhase("collection-neutral-owner", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue("root", {
			...text("collection-neutral-reply", "Understood."),
			check: (request) =>
				expect(JSON.stringify(request.context.messages), "continuous chat receives accepted knowledge").toContain(
					"Lives in Recife.",
				),
		});
		await withDeadline(world.trace, "collection neutral input", root.session.prompt("Hello again."));
		await icmWaitForChatIdle(world, agentDir, 4, (records) => records.length === 4);
		world.systemOne.enterPhase("collection-empty", {});
		world.provider.enqueue("root", {
			name: "collection-empty-submit",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "collection-empty-submit",
						name: "submit_knowledge_candidates",
						arguments: { complete: true, candidates: [] },
					},
				],
				stopReason: "toolUse",
			},
		});
		await withDeadline(world.trace, "empty collection armed", world.timers.whenArmed("knowledge-collection"));
		const emptyEnded = terminal(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "empty collection completed", emptyEnded)).toMatchObject({
			handoff: { retained: true },
			status: "completed",
			sources: 1,
			applied: 0,
			held: 0,
		});
		expect(store.list({ project: "", role: "", audience: "owner" })).toHaveLength(1);
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
}
