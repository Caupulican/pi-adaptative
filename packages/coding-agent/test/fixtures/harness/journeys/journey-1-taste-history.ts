import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type { KnowledgeCollectionOutcome } from "../../../../src/core/memory/knowledge-collector.ts";
import { KnowledgeStore } from "../../../../src/core/memory/knowledge-store.ts";
import {
	countOwnerCommitsAfter,
	REPOSITORY_HISTORY_ORIGIN,
	readOwnerHistory,
	UNINFORMATIVE_PATHSPECS,
} from "../../../../src/core/memory/repository-history.ts";
import { getDirectoryResourceProfileInfo } from "../../../../src/core/settings/settings-rules.ts";
import { handleTasteCommand } from "../../../../src/modes/interactive/taste-commands.ts";
import { createBarrier, fail, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { icmContinuousSettings, icmWaitForChatIdle, knowledgeJudgment } from "./shared.ts";

/** The identity this phase configures, and one whose address contains it: the case a bare author filter merges. */
const OWNER_EMAIL = "owner@example.test";
const CONTAINING_EMAIL = `a${OWNER_EMAIL}`;
/** An obviously fake credential assignment: the reader must return none of its value. */
const FAKE_SECRET = "API_KEY=abc123fakevalue";
/** Lines per wide file: two file diffs fit the per-commit character bound and the third does not. */
const WIDE_FILE_LINES = 90;

/**
 * Part of journey 1, near its end: the owner's own commits, read the way the mining task will read them. The root is a
 * repository long before this phase -- the proactivity phase made it one -- so the phase initialises nothing: it
 * configures the owner identity and adds its commits on top of the current head, staging only the files it wrote so
 * nothing another leg left untracked is committed here. Host only: no model turn, and the reader runs its default
 * runner, so every command crosses the world's process layer to the virtual git.
 */
export async function runJourney1TasteHistoryPhase(world: HarnessWorld): Promise<void> {
	const cwd = HARNESS_PROJECT_CWD;
	const before = world.git.refSha("refs/heads/main");
	if (before === undefined) throw new Error("This phase reads a repository the journey made earlier");
	world.git.configureIdentity(OWNER_EMAIL);
	const write = (path: readonly string[], text: string): string => {
		world.io.seed(projectPath(...path), text);
		return path.join("/");
	};
	const commit = (message: string, files: readonly string[], options: readonly string[] = []): void => {
		expect(world.git.run(["add", "--", ...files], cwd).code).toBe(0);
		expect(world.git.run([...options, "commit", "-m", message], cwd).code).toBe(0);
	};

	// A lock file beside a source file: the lock teaches nothing about how the owner writes and is not read.
	commit("Add the answer", [
		write(["package-lock.json"], '{"lockfileVersion": 3}\n'),
		write(["src", "taste", "history", "answer.ts"], "export const answer = 42;\n"),
	]);
	commit("Read the key from the environment", [
		write(["src", "taste", "history", "config.ts"], `export const settings = "${FAKE_SECRET}";\n`),
	]);
	commit(
		"Add three wide modules",
		[0, 1, 2].map((index) => {
			const lines = Array.from(
				{ length: WIDE_FILE_LINES },
				(_, line) => `export const value${index}_${line} = ${line};`,
			);
			return write(["src", "taste", "history", `wide${index}.ts`], `${lines.join("\n")}\n`);
		}),
	);
	commit(
		"Add a guest module",
		[write(["src", "taste", "history", "guest.ts"], "export const guest = 1;\n")],
		["-c", `user.email=${CONTAINING_EMAIL}`, "-c", "user.name=Another Author"],
	);

	const mark = world.processes.gitCalls.length;
	const sample = await readOwnerHistory({ cwd });
	if (sample.status !== "sample") throw new Error(`The owner's commits were not read: ${sample.reason}`);
	// The repository held commits before this phase, made with no identity, and the guest's address only contains the
	// owner's: the sample holds exactly the phase's own three commits.
	expect(world.git.run(["rev-list", "--count", `${before}..HEAD`], cwd).stdout.trim()).toBe("4");
	expect(sample.head).toBe(world.git.refSha("refs/heads/main"));
	expect(sample.identity).toBe(OWNER_EMAIL);
	expect(sample.commits.map((entry) => entry.subject)).toEqual([
		"Add three wide modules",
		"Read the key from the environment",
		"Add the answer",
	]);
	expect(sample.omittedCommits).toBe(0);
	const [wide, secret, answer] = sample.commits;
	expect(answer?.patch, "the lock file teaches nothing about how the owner writes").not.toContain("package-lock.json");
	expect(answer?.patch).toContain("diff --git a/src/taste/history/answer.ts b/src/taste/history/answer.ts");
	expect(answer?.patch).toContain("+export const answer = 42;");
	expect(secret?.patch, "no secret-shaped text from history leaves the reader").not.toContain("abc123fakevalue");
	expect(secret?.patch).toContain("[REDACTED]");
	expect(wide?.patch.length).toBeLessThanOrEqual(6_000);
	expect(wide?.patch.match(/^diff --git /gm), "whole file diffs only, never a partial one").toHaveLength(2);
	expect(wide?.patch).toContain("1 file diff left out");

	const oldest = sample.commits.at(-1)!;
	expect(await countOwnerCommitsAfter({ cwd, after: oldest.id })).toEqual({ status: "counted", count: 2 });
	expect(await countOwnerCommitsAfter({ cwd, after: "0".repeat(40) })).toEqual({
		status: "unknown",
		reason: "unknown_commit",
	});

	// The reader's own commands: no shell, no credential prompt, the owner named between brackets, and the exclusions.
	const calls = world.processes.gitCalls.slice(mark);
	expect(calls.length).toBeGreaterThan(0);
	expect(calls.every((call) => call.operation === "spawn" && call.file === "git")).toBe(true);
	expect(calls.every((call) => call.env.GIT_TERMINAL_PROMPT === "0")).toBe(true);
	expect(calls.find((call) => call.args[0] === "log")?.args).toEqual(
		expect.arrayContaining(["--no-merges", "--fixed-strings", `--author=<${OWNER_EMAIL}>`]),
	);
	expect(calls.find((call) => call.args[0] === "show")?.args).toEqual(
		expect.arrayContaining([...UNINFORMATIVE_PATHSPECS]),
	);
	expect(calls.find((call) => call.args[0] === "rev-list")?.args).toEqual(
		expect.arrayContaining(["--count", "--no-merges", `--author=<${OWNER_EMAIL}>`]),
	);

	// What the origin looked at is remembered, so the next look reads only what is new.
	const store = KnowledgeStore.open(`${world.agentDir}-taste-history`);
	try {
		store.originLooks.record("", REPOSITORY_HISTORY_ORIGIN, sample.head);
		expect(store.originLooks.last("", REPOSITORY_HISTORY_ORIGIN)?.cursor).toBe(sample.head);
	} finally {
		store.close();
	}
	await runTasteHistoryMiningLeg(world);
	await runTasteHistoryMiningOffLeg(world);
	await runTasteHistoryMiningFailedLeg(world);
	world.trace.mark("root", "taste.history.done");
}

/** The offer this leg's completion makes: one preference two commits show, and three it must refuse. */
const MINING_OFFERED = "Names a boolean value as a question, such as isReady.";
const MINING_DISAGREED = "Keeps every module under a hundred lines.";
const MINING_NOTICE = "Taste proposals from this repository's history: 1.  /taste proposals";
/** Owner commits this leg adds on top of the reader's three: a look reads no sample under five. */
const MINING_COMMITS = 3;
/** One root turn logs its words and the reply. */
const MINING_RECORDS = 2;
/** The look's two decisions: the valid proposal is kept, the one the commits do not show is not. */
const MINING_JUDGMENTS = [
	{ id: "shown_0", value: true, confidence: 0.95 },
	{ id: "shown_1", value: false, confidence: 0.5 },
] as const;
/** The delay a failed pass waits before its retry. */
const MINING_RETRY_MS = 60_000;

const miningOutcome = (session: AgentSession): Promise<KnowledgeCollectionOutcome> =>
	new Promise((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== "knowledge_collection") return;
			off();
			resolve(event);
		});
	});

/**
 * Each chat leaf and parent of a leg may compact; every reply is optional, so no leg waits on one. A track is one leg's:
 * its name carries the leg, because a track keeps the matcher it was first given.
 */
function registerMiningCompactionTracks(world: HarnessWorld, leg: string): string[] {
	const tracks: string[] = [];
	for (let size = 1; size <= MINING_RECORDS; size *= 2)
		for (let first = 0; first + size <= MINING_RECORDS; first += size) {
			const track = `${leg}-compaction-${first}+${size}`;
			tracks.push(track);
			world.provider.enqueueTrack(
				track,
				"worker-c",
				(request) =>
					JSON.stringify(request.context.messages.at(-1)).includes(
						size === 1 ? `Compaction: compress message ${first} into` : `Compaction: merge lines ${first}+`,
					),
				{ ...text(track, "Owner context and acknowledgement; original words remain available."), optional: true },
			);
		}
	return tracks;
}

/** The one line `/taste proposals` prints for a project's waiting proposals. */
async function tasteProposalsShown(session: AgentSession, agentDir: string): Promise<string> {
	const shown: string[] = [];
	await handleTasteCommand(
		{
			session: { memoryOperator: session.memoryOperator, ownerConfirm: undefined },
			cwd: agentDir,
			showStatus: (message) => shown.push(message),
			showError: (message) => shown.push(message),
			showText: (block) => shown.push(block),
		},
		"/taste proposals",
	);
	return shown.join("\n");
}

/** The empty extraction the first idle pass of a leg answers: the source is complete and nothing is proposed. */
function emptyCollectionStep(name: string): Parameters<HarnessWorld["provider"]["enqueue"]>[1] {
	return {
		name,
		check: (request) =>
			expect(request.context.tools?.map((tool) => tool.name)).toEqual(["knowledge", "submit_knowledge_candidates"]),
		reply: {
			content: [
				{
					type: "toolCall",
					id: name,
					name: "submit_knowledge_candidates",
					arguments: { complete: true, candidates: [] },
				},
			],
			stopReason: "toolUse",
		},
	};
}

/**
 * Part of journey 1, after the reader leg: an idle collection pass that claims no owner source reads this repository's
 * history once, a scripted completion offers four preferences, code drops three of them and one System One judgment keeps
 * the fourth, and the proposal waits for the owner. A later pass reads no git and buys no completion again.
 */
async function runTasteHistoryMiningLeg(world: HarnessWorld): Promise<void> {
	const cwd = HARNESS_PROJECT_CWD;
	const agentDir = `${world.agentDir}-taste-mining`;
	const project = getDirectoryResourceProfileInfo(cwd, agentDir).hash;
	for (let index = 0; index < MINING_COMMITS; index++) {
		const file = ["src", "taste", "mining", `module${index}.ts`].join("/");
		world.io.seed(
			projectPath("src", "taste", "mining", `module${index}.ts`),
			`export const value${index} = ${index};\n`,
		);
		expect(world.git.run(["add", "--", file], cwd).code).toBe(0);
		expect(world.git.run(["commit", "-m", `Add mining module ${index}`], cwd).code).toBe(0);
	}
	const sample = await readOwnerHistory({ cwd });
	if (sample.status !== "sample") throw new Error(`The owner's commits were not read: ${sample.reason}`);
	expect(sample.commits.length, "a look reads no sample under five commits").toBeGreaterThanOrEqual(5);
	const [first, second] = sample.commits;
	if (!first || !second) throw new Error("The sample holds fewer than two commits");
	const unknownId = `${"0".repeat(12)}${"1".repeat(28)}`;

	const autoLearn = { knowledgeIdleDelayMs: 1_000 };
	const root = await world.createRootSession("root", {
		agentDir,
		settings: icmContinuousSettings("worker-c", { autoLearn, proactivity: { enabled: false } }),
		sessionManager: world.createSessionManager(agentDir),
	});
	const store = KnowledgeStore.open(agentDir);
	const tracks = registerMiningCompactionTracks(world, "mining");
	try {
		// The owner's turn ends; the first idle pass collects that source and claims it, so this pass looks at no history.
		world.systemOne.enterPhase("mining-owner", {});
		world.provider.enqueue("root", text("mining-owner-reply", "Understood."));
		await withDeadline(world.trace, "mining owner input", root.session.prompt("Carry on."));
		await icmWaitForChatIdle(world, agentDir, MINING_RECORDS, (records) => records.length === MINING_RECORDS);
		world.provider.enqueue("root", emptyCollectionStep("mining-empty"));
		await withDeadline(world.trace, "mining collection armed", world.timers.whenArmed("knowledge-collection"));
		const collected = miningOutcome(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "mining owner source collected", collected)).toMatchObject({
			status: "completed",
			sources: 1,
			applied: 0,
		});
		expect(
			store.originLooks.last(project, REPOSITORY_HISTORY_ORIGIN),
			"a pass that claimed a source asks no history",
		).toBeUndefined();

		// The next pass claims no source: it reads the history once and asks the model for taste proposals.
		const warningMark = world.warnings.length;
		const reached = createBarrier();
		world.systemOne.enterPhase("mining-history", {
			shown_0: { kind: "noul", probability: 0.95 },
			shown_1: { kind: "noul", probability: 0.5 },
		});
		world.provider.enqueue("root", {
			name: "mining-history-submit",
			check: (request) => {
				expect(request.context.tools?.map((tool) => tool.name)).toEqual(["submit_taste_proposals"]);
				const messages = JSON.stringify(request.context.messages);
				expect(messages, "the commits are fenced as data").toContain("untrusted_content");
				expect(messages).toContain(first.id);
				reached.release();
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "mining-history-submit",
						name: "submit_taste_proposals",
						arguments: {
							proposals: [
								{
									subject: "naming",
									key: "boolean-questions",
									text: MINING_OFFERED,
									commits: [first.id, second.id],
									note: "Both commits name a boolean as a question.",
								},
								{
									subject: "naming",
									key: "one-commit",
									text: "Keeps every module small.",
									commits: [first.id, first.id],
									note: "One commit cannot show a habit.",
								},
								{
									subject: "structure",
									key: "no-long-chains",
									text: "Avoids long chains of calls.",
									commits: [first.id, unknownId],
									note: "A commit the sample does not hold.",
								},
								{
									subject: "structure",
									key: "short-modules",
									text: MINING_DISAGREED,
									commits: [first.id.slice(0, 8), second.id.slice(0, 8)],
									note: "Both commits stay short.",
								},
							],
						},
					},
				],
				stopReason: "toolUse",
			},
		});
		// With System One unbound the session's own judge answers the look's program after the reading, as it answers
		// admission: its request follows the reading's on the same track.
		if (!world.systemOne.enabled)
			world.provider.enqueue(
				"root",
				knowledgeJudgment("mining-history-judgment", "taste.history", MINING_JUDGMENTS, () => MINING_OFFERED),
			);
		// A settings change re-arms the collector; its pass claims nothing and looks at the repository instead.
		root.settingsManager.setAutoLearnSettings({ ...autoLearn, historyMaxUsd: 0.25 });
		await withDeadline(world.trace, "mining look armed", world.timers.whenArmed("knowledge-collection"));
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		await withDeadline(world.trace, "mining look reached the model", reached.promise);
		await withDeadline(
			world.trace,
			"mining notice shown",
			world.whenWarnings(warningMark, (seen) => seen.includes(MINING_NOTICE)),
		);

		const pending = store.proposals.listPending(project);
		expect(pending, "code dropped two proposals and one judgment dropped the third").toHaveLength(1);
		expect(pending[0]).toMatchObject({ kind: "taste", origin: REPOSITORY_HISTORY_ORIGIN, project });
		expect(pending[0]?.content).toMatchObject({
			text: MINING_OFFERED,
			evidence: [
				{ ref: first.id.slice(0, 12), note: first.subject },
				{ ref: second.id.slice(0, 12), note: second.subject },
			],
		});
		expect(store.originLooks.last(project, REPOSITORY_HISTORY_ORIGIN)?.cursor, "the look remembers the head").toBe(
			sample.head,
		);
		expect(
			store.list({ project, role: "", audience: "owner" }, { kind: "taste" }),
			"nothing becomes knowledge without /taste accept",
		).toEqual([]);
		expect(
			world.warnings.slice(warningMark).filter((line) => line.startsWith("Taste proposals from this repository")),
			"one informational line for one proposal",
		).toEqual([MINING_NOTICE]);
		const listed = await tasteProposalsShown(root.session, agentDir);
		expect(listed).toContain(MINING_OFFERED);
		expect(listed).toContain(REPOSITORY_HISTORY_ORIGIN);
		expect(listed).toContain(first.id.slice(0, 12));

		// A decided look is not asked again: the next idle pass reads no git and buys no completion.
		const gitMark = world.processes.gitCalls.length;
		const requestMark = world.provider.requests.length;
		root.settingsManager.setAutoLearnSettings({ ...autoLearn, historyMaxUsd: 0.2 });
		await withDeadline(world.trace, "mining quiet armed", world.timers.whenArmed("knowledge-collection"));
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		await withDeadline(
			world.trace,
			"mining quiet pass ended",
			root.session.memoryOperator.knowledgeCollectionSettled(),
		);
		expect(world.processes.gitCalls.length, "the collector reads git once").toBe(gitMark);
		expect(world.provider.requests.length, "no completion is bought again").toBe(requestMark);
	} finally {
		store.close();
		expect(await world.disposeSessionInBody(root.session), "the mining owner closes cleanly").toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
}

/** The same idle pass with `autoLearn.history` off: no look, so no git read and no completion. */
async function runTasteHistoryMiningOffLeg(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-taste-mining-off`;
	const autoLearn = { knowledgeIdleDelayMs: 1_000, history: false };
	const root = await world.createRootSession("root", {
		agentDir,
		settings: icmContinuousSettings("worker-c", { autoLearn, proactivity: { enabled: false } }),
		sessionManager: world.createSessionManager(agentDir),
	});
	const store = KnowledgeStore.open(agentDir);
	const tracks = registerMiningCompactionTracks(world, "mining-off");
	try {
		world.systemOne.enterPhase("mining-off-owner", {});
		world.provider.enqueue("root", text("mining-off-reply", "Understood."));
		await withDeadline(world.trace, "mining off owner input", root.session.prompt("Carry on."));
		await icmWaitForChatIdle(world, agentDir, MINING_RECORDS, (records) => records.length === MINING_RECORDS);
		world.provider.enqueue("root", emptyCollectionStep("mining-off-empty"));
		await withDeadline(world.trace, "mining off armed", world.timers.whenArmed("knowledge-collection"));
		const collected = miningOutcome(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "mining off source collected", collected)).toMatchObject({ sources: 1 });
		const gitMark = world.processes.gitCalls.length;
		const requestMark = world.provider.requests.length;
		root.settingsManager.setAutoLearnSettings({ ...autoLearn, historyMaxUsd: 0.2 });
		await withDeadline(world.trace, "mining off idle armed", world.timers.whenArmed("knowledge-collection"));
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		await withDeadline(
			world.trace,
			"mining off pass ended",
			root.session.memoryOperator.knowledgeCollectionSettled(),
		);
		expect(world.processes.gitCalls.length, "history off reads no git").toBe(gitMark);
		expect(world.provider.requests.length, "history off buys no completion").toBe(requestMark);
	} finally {
		store.close();
		expect(await world.disposeSessionInBody(root.session), "the second mining owner closes cleanly").toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
}

/**
 * The look's retry bound: two looks whose request fails are asked twice, then the look is decided, so a provider that
 * always fails costs two requests rather than one on every later idle pass.
 */
async function runTasteHistoryMiningFailedLeg(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-taste-mining-failed`;
	const autoLearn = { knowledgeIdleDelayMs: 1_000 };
	const root = await world.createRootSession("root", {
		agentDir,
		settings: icmContinuousSettings("worker-c", { autoLearn, proactivity: { enabled: false } }),
		sessionManager: world.createSessionManager(agentDir),
	});
	const store = KnowledgeStore.open(agentDir);
	const tracks = registerMiningCompactionTracks(world, "mining-failed");
	try {
		world.systemOne.enterPhase("mining-failed-owner", {});
		world.provider.enqueue("root", text("mining-failed-reply", "Understood."));
		await withDeadline(world.trace, "mining failed owner input", root.session.prompt("Carry on."));
		await icmWaitForChatIdle(world, agentDir, MINING_RECORDS, (records) => records.length === MINING_RECORDS);
		world.provider.enqueue("root", emptyCollectionStep("mining-failed-empty"));
		await withDeadline(world.trace, "mining failed armed", world.timers.whenArmed("knowledge-collection"));
		const collected = miningOutcome(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "mining failed source collected", collected)).toMatchObject({
			sources: 1,
		});

		// The first look fails: the pass ends failed with no source, and the look stays undecided.
		world.provider.enqueue("root", fail("mining-look-fail-1", "The look's reading failed."));
		root.settingsManager.setAutoLearnSettings({ ...autoLearn, historyMaxUsd: 0.25 });
		await withDeadline(world.trace, "mining first look armed", world.timers.whenArmed("knowledge-collection"));
		const firstFailed = miningOutcome(root.session);
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		expect(await withDeadline(world.trace, "mining first look failed", firstFailed)).toMatchObject({
			status: "failed",
			sources: 0,
		});

		// The collector's own retry is the second attempt, and it fails too: two failed looks decide the look.
		world.provider.enqueue("root", fail("mining-look-fail-2", "The look's reading failed again."));
		const secondFailed = miningOutcome(root.session);
		expect(world.timers.advance("knowledge-collection", MINING_RETRY_MS)).toBe(1);
		expect(await withDeadline(world.trace, "mining second look failed", secondFailed)).toMatchObject({
			status: "failed",
			sources: 0,
		});

		// A decided look reads no git and buys no completion on any later pass.
		const gitMark = world.processes.gitCalls.length;
		const requestMark = world.provider.requests.length;
		root.settingsManager.setAutoLearnSettings({ ...autoLearn, historyMaxUsd: 0.2 });
		await withDeadline(world.trace, "mining failed quiet armed", world.timers.whenArmed("knowledge-collection"));
		expect(world.timers.advance("knowledge-collection", 1_000)).toBe(1);
		await withDeadline(
			world.trace,
			"mining failed quiet pass ended",
			root.session.memoryOperator.knowledgeCollectionSettled(),
		);
		expect(world.processes.gitCalls.length, "a decided look reads no git").toBe(gitMark);
		expect(world.provider.requests.length, "a decided look buys no completion").toBe(requestMark);
	} finally {
		store.close();
		expect(await world.disposeSessionInBody(root.session), "the failed-look owner closes cleanly").toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
}
