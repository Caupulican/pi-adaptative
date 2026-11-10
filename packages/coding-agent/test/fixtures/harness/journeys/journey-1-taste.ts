import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
} from "../../../../src/core/learning/owner-evidence-ledger.ts";
import type { KnowledgeCollectionOutcome } from "../../../../src/core/memory/knowledge-collector.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { handleTasteCommand } from "../../../../src/modes/interactive/taste-commands.ts";
import { text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, icmContinuousSettings, icmWaitForChatIdle, knowledgeJudgment } from "./shared.ts";

/** The session model's answers with System One off: a stated preference that was not a request to remember it. */
const JUDGED_STATED = [
	{ id: "grounded", value: true, confidence: 0.98 },
	{ id: "basis", selected: "explicit", confidence: 0.98 },
	{ id: "requested", value: false, confidence: 0.98 },
] as const;
/** Two turns, each logging the owner's words and the reply. */
const CHAT_RECORDS = 4;
const OWNER_WORDS = "In TypeScript I always prefer early returns over nested conditionals.";
const TASTE_TEXT = "Prefers early returns over nested conditionals in TypeScript.";

/** Each of the chat's possible leaf and parent compactions gets at most one optional reply. */
function registerCompactionTracks(world: HarnessWorld): string[] {
	const tracks: string[] = [];
	for (let size = 1; size <= CHAT_RECORDS; size *= 2) {
		for (let first = 0; first + size <= CHAT_RECORDS; first += size) {
			const task =
				size === 1
					? `Compaction: compress message ${first} into`
					: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
			const track = `taste-compaction-${first}+${size}`;
			tracks.push(track);
			world.provider.enqueueTrack(
				track,
				"worker-c",
				(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
				{ ...text(track, "Owner coding preference; original words remain available."), optional: true },
			);
		}
	}
	return tracks;
}

const nextCollectionOutcome = (session: AgentSession): Promise<KnowledgeCollectionOutcome> =>
	new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== "knowledge_collection") return;
			off();
			resolve(event);
		});
	});

/**
 * Part of journey 1: an owner message that plainly states a coding preference is collected as a `taste` fact, and the
 * next request's knowledge projection carries it under its kind label. Scripted like the first collection step: with
 * System One off the session model judges the one candidate.
 */
export async function runJourney1TastePhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-taste`;
	const root = await world.createRootSession("root", {
		agentDir,
		settings: icmContinuousSettings("worker-c", {
			autoLearn: { knowledgeIdleDelayMs: 1_000 },
			proactivity: { enabled: false },
		}),
		sessionManager: world.createSessionManager(agentDir),
	});
	const store = KnowledgeStore.open(agentDir);
	const tracks = registerCompactionTracks(world);
	try {
		world.systemOne.enterPhase("taste-owner", {});
		world.provider.enqueue("root", text("taste-owner-reply", "Understood."));
		await withDeadline(world.trace, "taste owner input", root.session.prompt(OWNER_WORDS));
		await icmWaitForChatIdle(world, agentDir, 2, (records) => records.length === 2);
		const original = getOwnerEvidenceSnapshots(
			root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]),
		).at(-1)!;
		expect(original.text).toBe(OWNER_WORDS);

		world.systemOne.enterPhase("taste-admission", {
			grounded: { kind: "noul", probability: 0.98 },
			basis: { kind: "choice", choice: "explicit", confidence: 0.98 },
			requested: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue(
			"root",
			{
				name: "taste-submit",
				check: (request) => expect(JSON.stringify(request.context.messages)).toContain(original.sourceId),
				reply: {
					content: [
						{
							type: "toolCall",
							id: "taste-submit",
							name: "submit_knowledge_candidates",
							arguments: {
								complete: true,
								candidates: [
									{
										action: "remember",
										kind: "taste",
										scope: "global",
										subject: "owner",
										key: "control-flow",
										text: TASTE_TEXT,
										evidence: [
											{ source: original.sourceId, quote: "prefer early returns over nested conditionals" },
										],
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
							"taste-judgment",
							"knowledge.admission",
							JUDGED_STATED,
							() => "prefer early returns over nested conditionals",
						),
					]),
		);
		await withDeadline(world.trace, "taste collection armed", world.timers.whenArmed("knowledge-collection"));
		const ended = nextCollectionOutcome(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "taste collection committed", ended)).toMatchObject({
			status: "completed",
			sources: 1,
			applied: 1,
			held: 0,
		});
		expect(store.list({ project: "", role: "", audience: "owner" })).toMatchObject([
			{ kind: "taste", text: TASTE_TEXT, basis: "explicit" },
		]);

		// `/taste` reads the committed record without a model turn: its Markdown names the fact, its basis and its sources.
		const shown: string[] = [];
		await handleTasteCommand(
			{
				session: root.session,
				cwd: agentDir,
				showStatus: (message) => shown.push(message),
				showError: (message) => shown.push(message),
				showText: (block) => shown.push(block),
			},
			"/taste",
		);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain(TASTE_TEXT);
		expect(shown[0]).toContain("stated");
		expect(shown[0]).toContain("1 source");

		world.systemOne.enterPhase("taste-projection-owner", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue("root", {
			...text("taste-projection-reply", "Understood."),
			check: (request) => {
				const messages = JSON.stringify(request.context.messages);
				expect(messages, "the next request carries the taste fact under its kind label").toMatch(
					/knowledge:taste \{/,
				);
				expect(messages).toContain(TASTE_TEXT);
			},
		});
		await withDeadline(world.trace, "taste projection input", root.session.prompt("Thanks, carry on."));
		await icmWaitForChatIdle(world, agentDir, CHAT_RECORDS, (records) => records.length === CHAT_RECORDS);
		world.trace.mark("root", "knowledge.taste-projection");
	} finally {
		store.close();
		expect(await world.disposeSessionInBody(root.session), "the taste owner closes cleanly").toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
}
