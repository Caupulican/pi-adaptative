import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
} from "../../../../src/core/learning/owner-evidence-ledger.ts";
import { emitKnowledgeCollection } from "../../../../src/core/memory/knowledge-announcement.ts";
import type { KnowledgeCollectionOutcome } from "../../../../src/core/memory/knowledge-collector.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import { handleKnowledgeCommand } from "../../../../src/modes/interactive/knowledge-commands.ts";
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
const TASTE_NOTICE = `Learned (taste): ${TASTE_TEXT}`;

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

const PROPOSAL_ONE = "Names boolean variables as questions, such as isReady.";
const PROPOSAL_REVISED = "Names boolean variables as questions, such as isReady or hasItems.";
const PROPOSAL_TWO = "Keeps functions under forty lines.";

/**
 * Proposals wait for the owner: `/taste accept` states one as the owner's own command, `/taste reject` drops one, and
 * neither the accepted nor the rejected text is offered again. No model turn runs; the host records what is shown.
 */
async function runProposalLeg(session: AgentSession, store: KnowledgeStore, agentDir: string): Promise<void> {
	const owner = { project: "", role: "", audience: "owner" };
	const offer = (text: string, ref: string) =>
		store.proposals.offer({
			project: "",
			kind: "taste",
			origin: "repository-history",
			subject: "owner",
			key: text.slice(0, 20),
			text,
			evidence: [{ ref, note: `Seen in ${ref}` }],
		});
	const first = offer(PROPOSAL_ONE, "commit-aaaa111");
	const second = offer(PROPOSAL_TWO, "commit-bbbb222");
	if (first.status !== "offered" || second.status !== "offered") throw new Error("Proposals were not offered");
	const short = (id: string) => id.slice(0, 8);

	const run = async (command: string, confirm: boolean | undefined): Promise<string[]> => {
		const shown: string[] = [];
		await handleTasteCommand(
			{
				session: {
					memoryOperator: session.memoryOperator,
					ownerConfirm: confirm === undefined ? undefined : async () => confirm,
				},
				cwd: agentDir,
				showStatus: (message) => shown.push(message),
				showError: (message) => shown.push(message),
				showText: (block) => shown.push(block),
			},
			command,
		);
		return shown;
	};

	const listed = await run("/taste proposals", undefined);
	expect(listed).toHaveLength(1);
	for (const [id, ref, body] of [
		[first.id, "commit-aaaa111", PROPOSAL_ONE],
		[second.id, "commit-bbbb222", PROPOSAL_TWO],
	] as const) {
		expect(listed[0]).toContain(body);
		expect(listed[0]).toContain(ref);
		expect(listed[0]).toContain(short(id));
	}

	// Without an owner confirmation nothing changes.
	expect(await run(`/taste accept ${short(first.id)}`, false)).toEqual([
		"Nothing changed: the owner did not confirm.",
	]);
	expect(await run(`/taste accept ${short(first.id)}`, undefined)).toEqual([
		"Nothing changed: owner confirmation is unavailable.",
	]);
	expect(store.list(owner, { kind: "taste" })).toHaveLength(1);
	expect((await run("/taste proposals", undefined))[0]).toContain(PROPOSAL_ONE);

	const accepted = await run(`/taste accept ${short(first.id)}`, true);
	expect(accepted).toHaveLength(1);
	const stated = store.list(owner, { kind: "taste" }).find((record) => record.text === PROPOSAL_ONE)!;
	expect(accepted[0]).toContain(`/knowledge show ${short(stated.id)}`);
	expect(accepted[0]).toContain(short(first.id));
	expect(stated.basis).toBe("explicit");
	expect(stated.citations).toHaveLength(1);
	expect(stated.citations[0]!.sourceId.startsWith("owner-command:")).toBe(true);
	const shownTaste = await run("/taste", undefined);
	expect(shownTaste[0]).toContain(PROPOSAL_ONE);
	expect(shownTaste[0]).toContain("stated");
	const remaining = (await run("/taste proposals", undefined))[0]!;
	expect(remaining).toContain(PROPOSAL_TWO);
	expect(remaining).not.toContain(PROPOSAL_ONE);

	expect(await run(`/taste reject ${short(second.id)}`, undefined)).toEqual([
		`Rejected proposal ${short(second.id)}. It will not be proposed again.`,
	]);
	expect(await run("/taste proposals", undefined)).toEqual(["No taste proposals are waiting."]);
	expect(store.list(owner, { kind: "taste" }).some((record) => record.text === PROPOSAL_TWO)).toBe(false);

	expect(offer(PROPOSAL_TWO, "commit-cccc333")).toEqual({ status: "known", id: second.id, state: "rejected" });
	expect(offer(PROPOSAL_ONE, "commit-dddd444")).toEqual({ status: "known", id: first.id, state: "accepted" });

	// A fact the owner forgot can be stated again: the new statement is newer than the forget and is a new operation.
	const forget: string[] = [];
	await handleKnowledgeCommand(
		{
			session: { memoryOperator: session.memoryOperator, ownerConfirm: async () => true },
			showStatus: (message) => forget.push(message),
			showError: (message) => forget.push(message),
			showText: (block) => forget.push(block),
		},
		`/knowledge forget ${short(stated.id)}`,
	);
	expect(forget.join("\n")).toContain(`Forgot ${short(stated.id)}`);
	expect(store.get(stated.id)).toBeUndefined();
	const again = store.proposals.offer({
		project: "",
		kind: "taste",
		origin: "repository-history",
		subject: "owner",
		key: PROPOSAL_ONE.slice(0, 20),
		text: PROPOSAL_REVISED,
		evidence: [{ ref: "commit-eeee555", note: "Seen in commit-eeee555" }],
	});
	if (again.status !== "offered") throw new Error("The revised proposal was not offered");
	const restated = await run(`/taste accept ${short(again.id)}`, true);
	expect(restated).toHaveLength(1);
	expect(restated[0]).toContain("Accepted proposal");
	const back = store.get(stated.id)!;
	expect(back.text).toBe(PROPOSAL_REVISED);
	expect(back.basis).toBe("explicit");
	expect(back.revision).toBeGreaterThan(stated.revision);
	expect(back.citations).toHaveLength(1);
	expect(back.citations[0]!.sourceId.startsWith("owner-command:")).toBe(true);
}

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
		const warningMark = world.warnings.length;
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

		// The owner sees what was learned: one plain line, with the way to open the fact.
		await withDeadline(
			world.trace,
			"taste notice shown",
			world.whenWarnings(warningMark, (seen) => seen.some((line) => line.startsWith(TASTE_NOTICE))),
		);
		expect(world.warnings.slice(warningMark)).toEqual([
			`${TASTE_NOTICE}  /knowledge show ${store.list({ project: "", role: "", audience: "owner" })[0]!.id.slice(0, 8)}`,
		]);

		// `autoLearn.announce: false` silences it: the same outcome emits its event and no line.
		const silent: string[] = [];
		emitKnowledgeCollection(
			{
				outcome: { id: "silent", status: "completed", sources: 1, applied: 1, rejected: 0, held: 0 },
				changes: { changes: [{ kind: "taste", id: "0".repeat(64), text: TASTE_TEXT, existed: false }], more: 0 },
			},
			{ getAutonomySettings: () => ({ mode: "balanced" }), getAutoLearnSettings: () => ({ announce: false }) },
			(event) => silent.push(event.type),
		);
		expect(silent).toEqual(["knowledge_collection"]);

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

		await runProposalLeg(root.session, store, agentDir);

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
				expect(messages, "the owner's notice is not part of the request").not.toContain(TASTE_NOTICE);
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
