import { expect } from "vitest";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
} from "../../../../src/core/learning/owner-evidence-ledger.ts";
import type { KnowledgeChange } from "../../../../src/core/memory/knowledge-admission.ts";
import { knowledgeId } from "../../../../src/core/memory/knowledge-record.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, icmContinuousSettings, icmLatestResult, icmWaitForChatIdle } from "./shared.ts";

const GROUNDED = {
	grounded: { kind: "noul", probability: 0.98 },
	basis: { kind: "choice", choice: "explicit", confidence: 0.98 },
	requested: { kind: "noul", probability: 0.98 },
} as const;
const SAME_SLOT = { same_0: { kind: "noul", probability: 0.98 } } as const;

/** Existing journey 1: real tool admission, correction, forgetting, and both directions of stale replay. */
export async function runJourney1KnowledgePhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-knowledge`;
	const root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: icmContinuousSettings("worker-c", { autoLearn: { enabled: false }, proactivity: { enabled: false } }),
	});
	const store = KnowledgeStore.open(agentDir);
	// Six turns publish four records each. Every possible leaf and aligned parent gets at most one reply:
	// short nodes need no call, but concurrent compactions may consume these exact targets in any order.
	const compactionTracks: string[] = [];
	for (let size = 1; size <= 24; size *= 2) {
		for (let first = 0; first + size <= 24; first += size) {
			const task =
				size === 1
					? `Compaction: compress message ${first} into`
					: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
			const track = `knowledge-compaction-${first}+${size}`;
			compactionTracks.push(track);
			world.provider.enqueueTrack(
				track,
				"worker-c",
				(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
				{
					name: track,
					optional: true,
					reply: {
						content: [
							{ type: "text", text: "Knowledge requests and their results; zoom for the original evidence." },
						],
					},
				},
			);
		}
	}
	let completedTurns = 0;
	const id = knowledgeId({
		kind: "behavior",
		scope: { project: "", role: "", audience: "owner" },
		subject: "owner",
		key: "indentation",
	});
	const source = () => {
		const record = getOwnerEvidenceSnapshots(
			root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]),
		).at(-1);
		if (!record) throw new Error("The real owner input did not produce original evidence");
		return record.sourceId;
	};
	const remember = (text: string, quote: string, cited = source(), key = "indentation"): KnowledgeChange => ({
		action: "remember",
		kind: "behavior",
		scope: "global",
		subject: "owner",
		key,
		text,
		evidence: [{ source: cited, quote }],
	});
	const turn = async (
		label: string,
		prompt: string,
		change: () => KnowledgeChange,
		expected: string,
		matching = false,
	) => {
		world.systemOne.enterPhase(label, {
			...ICM_INTAKE_JUDGMENTS,
			...(world.systemOne.enabled ? { ...GROUNDED, ...(matching ? SAME_SLOT : {}) } : {}),
		});
		world.provider.enqueue(
			"root",
			{
				name: `${label}-call`,
				reply: () => ({
					content: [
						{ type: "toolCall", id: label, name: "knowledge", arguments: { action: "change", change: change() } },
					],
					stopReason: "toolUse",
				}),
			},
			{
				name: `${label}-done`,
				check: (request) =>
					expect(
						icmLatestResult(request, "knowledge").text,
						"the actual tool reports its admission result",
					).toContain(expected),
				reply: { content: [{ type: "text", text: "Recorded the outcome." }] },
			},
		);
		await withDeadline(world.trace, label, root.session.prompt(prompt));
		completedTurns++;
		await icmWaitForChatIdle(world, agentDir, completedTurns * 4, (records) => records.length === completedTurns * 4);
	};
	try {
		let firstSource = "";
		await turn(
			"knowledge-add",
			"Remember I use tabs.",
			() => {
				firstSource = source();
				return remember("Uses tabs.", "I use tabs");
			},
			world.systemOne.enabled ? '"status":"applied"' : "semantic engine is unavailable",
		);
		if (!world.systemOne.enabled) {
			expect(store.get(id), "without semantic grounding, no durable fact is invented").toBeUndefined();
			return;
		}
		expect(store.get(id), "explicit owner instructions work even with automatic learning disabled").toMatchObject({
			text: "Uses tabs.",
			revision: 1,
		});
		await turn(
			"knowledge-correct",
			"Actually, remember I use spaces.",
			() => remember("Uses spaces.", "I use spaces", source(), "whitespace"),
			'"status":"applied"',
			true,
		);
		expect(store.get(id), "different wording corrects the existing semantic slot").toMatchObject({
			text: "Uses spaces.",
			revision: 2,
		});
		expect(
			store.list({ project: "", role: "", audience: "owner" }),
			"correction does not create a second fact",
		).toHaveLength(1);
		let forgetSource = "";
		await turn(
			"knowledge-forget",
			"Forget my indentation preference.",
			() => {
				forgetSource = source();
				return {
					action: "forget",
					id,
					expectedRevision: 2,
					evidence: [{ source: forgetSource, quote: "Forget my indentation preference" }],
				};
			},
			'"status":"applied"',
		);
		expect(store.get(id), "forget removes the accepted value").toBeUndefined();
		expect(store.history(id), "forget removes value history too").toEqual([]);
		await turn(
			"knowledge-replay",
			"Inspect that old request.",
			() => remember("Uses tabs.", "I use tabs", firstSource, "formatting"),
			"not newer",
			true,
		);
		expect(store.get(id), "alternate wording cannot replay forgotten evidence").toBeUndefined();
		await turn(
			"knowledge-relearn",
			"Remember I use tabs again.",
			() => remember("Uses tabs again.", "I use tabs again", source(), "formatting"),
			'"status":"applied"',
			true,
		);
		expect(store.get(id), "a fresh explicit request can relearn the same slot").toMatchObject({
			revision: 4,
			text: "Uses tabs again.",
		});
		await turn(
			"knowledge-old-forget",
			"Inspect the earlier forgetting request.",
			() => ({
				action: "forget",
				id,
				expectedRevision: 4,
				evidence: [{ source: forgetSource, quote: "Forget my indentation preference" }],
			}),
			"older than the current knowledge",
		);
		expect(store.get(id), "an old forgetting request cannot delete a fresh fact").toMatchObject({
			revision: 4,
			text: "Uses tabs again.",
		});
		world.trace.mark("root", "knowledge.admission-replay");
	} finally {
		store.close();
		expect(await world.disposeSessionInBody(root.session), "the knowledge owner closes cleanly").toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of compactionTracks) world.provider.retireOptional(track);
	}
}
