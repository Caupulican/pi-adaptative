import { dirname, join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { outwardDraftStates } from "../../../../src/core/agent-session-edge.ts";
import {
	type CiAttemptTerminalEvent,
	type CiSubject,
	createCiAttemptTerminalEvent,
} from "../../../../src/core/events/host-event-contract.ts";
import { WATCH_AUTO_ARM_CUSTOM_TYPE } from "../../../../src/core/watches/watch-auto-arm.ts";
import { createCiHostRuntime } from "../../../../src/host/ci/ci-host-event-source.ts";
import type { CiProvider, CiProviderCollection, CiRepository } from "../../../../src/host/ci/ci-provider.ts";
import { CiSourceStore } from "../../../../src/host/ci/ci-source-store.ts";
import type { CiGitPaths } from "../../../../src/host/ci/ci-status-record.ts";
import { calls, createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import {
	HARNESS_PROJECT_CWD,
	type HarnessWorld,
	NATIVE_PLATFORM_SHELL_BY_DEFAULT,
	withDeadline,
} from "../session-fixture.ts";
import { deliveryWith, FakeBotApi, OWNER_ID, ownerLegUpdate, TOKEN, withFakeBotApi } from "./journey-4-telegram.ts";
import { scriptRequirementCheckSpawn } from "./journey-9-shared.ts";
import {
	requestTexts,
	scriptGithubWatchWake,
	sessionLedgerWatches,
	sessionWatchOutcome,
	settleWatchWake,
} from "./journey-watch-wake.ts";
import {
	ICM_INTAKE_JUDGMENTS,
	latestBatchResults,
	NO_DELIVERY_CLAIMS,
	refusalDiagnostic,
	refusalNextAction,
} from "./shared.ts";

/** At most eight characters: a held line never shortens it, so the hold names it whole. */
const WATCH_ID = "release";
const WATCH_COMMAND = "./scripts/release-status.sh";
const WATCH_PLAN = "Tell the owner the release build finished, with its status line.";

interface WatchLegJournal {
	readonly seen: readonly { readonly d: string }[];
	readonly ownerPushes?: readonly { readonly k: string; readonly c?: string }[];
}

/**
 * A command watch armed from the phone under the owner's full authority (`ownerAuthority: "full"`), with no standing
 * grant (`edge.allow: []`). The owner's words open the run and are the request it answers, so the `routine` call that
 * arms the watch is saved on them. With System One on, its effect reading of the watch's check (a project script it
 * cannot read) is unsettled and the owner's request does not settle it either, so the check is held for the owner: a
 * draft named for the watch is presented on the phone and nothing is armed. `approve <id>` opens a turn that repeats
 * the `routine` call; that run answers the request the draft was held in, so the watch is saved on the owner's words
 * from the phone (`armedBy` names that message), the approval admits the check once and is recorded spent (the draft is
 * released), and the watch takes its first sample. With System One off nothing judges the check: the first call arms
 * the watch, on the same owner words.
 */
export async function runJourney4TelegramWatchPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const held = world.systemOne.enabled;
	const agentDir = `${world.agentDir}-telegram-watch`;
	const channelsDir = join(agentDir, "channels");
	const tokenPath = join(channelsDir, "telegram.token");
	const journalPath = join(channelsDir, "telegram.json");
	world.io.mkdirSync(channelsDir, { recursive: true });
	world.io.writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	const journal = (): WatchLegJournal =>
		world.io.existsSync(journalPath)
			? (JSON.parse(String(world.io.readFileSync(journalPath))) as WatchLegJournal)
			: { seen: [] };
	const api = new FakeBotApi(() => journal().seen.map((entry) => entry.d));
	const warningsBefore = world.warnings.length;
	const ownerChat = String(OWNER_ID);
	const ownerHeader = "Owner message on channel telegram (verified private chat, 1 message";
	// Each check of the watched command is a requirement-check process: the world's shell answers that command line.
	const scriptedCheck = scriptRequirementCheckSpawn(world, WATCH_COMMAND);
	try {
		await withFakeBotApi(world, api, async () => {
			const firstPoll = api.nextPoll(undefined);
			const manager = world.createSessionManager(agentDir);
			const created = await world.createRootSession("root", {
				agentDir,
				sessionManager: manager,
				settings: {
					autoLearn: { enabled: false },
					proactivity: { enabled: false },
					orchestrator: { delegationGate: false },
					routines: { automaticIntake: false },
					edge: { allow: [] },
					channels: { telegram: { mode: "explicit", ownerSenders: [OWNER_ID], ownerAuthority: "full" } },
				},
			});
			const session: AgentSession = created.session;
			await withDeadline(trace, "the watch leg's first poll", firstPoll);
			const store = () => session.backgroundLanes.getBotTeamStore();
			const watchDraft = () =>
				outwardDraftStates(manager.getBranch(), false).find((view) => view.record.purpose?.watchId === WATCH_ID);
			trace.mark("root", "telegram-watch.polling");

			const words = "tell me when the release build finishes";
			const routineCall = (id: string) => ({
				id,
				name: "routine",
				arguments: {
					action: "create",
					routineId: WATCH_ID,
					prompt: WATCH_PLAN,
					schedule: {
						kind: "event",
						source: "watch",
						condition: {
							type: "command",
							command: WATCH_COMMAND,
							everyMs: 60_000,
							expect: { outputContains: "release: done" },
						},
					},
				},
			});
			// The watch's first sample, once it is armed: the build is still running.
			const baselineSampled = createBarrier();
			world.shell.enqueue({
				name: "j4-tg-watch-baseline",
				command: WATCH_COMMAND,
				output: "release: building\n",
				exitCode: 0,
				effect: () => baselineSampled.release(),
			});
			// The owner's words from the phone are judged as the owner's typed words are (full authority gives them a
			// submission order; no grant is standing, so whether they grant one is asked too). System One cannot read
			// what the project script does: whether it changes files outside the task or cannot be undone stays
			// unsettled (above the effect family's 0.5 absence cut, below its 0.8 presence), and the request does not
			// settle it (between 0.2 and 0.8), so the check goes to the owner. The held run's answer names the watch's check,
			// a word the answer claim check reads for, and claims nothing delivered; the approval run's answer names no such word.
			world.systemOne.enterPhase("j4-tg-watch-request", {
				...ICM_INTAKE_JUDGMENTS,
				...NO_DELIVERY_CLAIMS,
				leaves_machine: { kind: "noul", probability: 0.1 },
				cannot_be_undone: { kind: "noul", probability: 0.6 },
				touches_outside_task: { kind: "noul", probability: 0.6 },
				acquires_external_code: { kind: "noul", probability: 0.1 },
				request_authorizes: { kind: "noul", probability: 0.5 },
			});
			const requestAnswered = createBarrier();
			let firstResult: { isError: boolean; text: string } | undefined;
			world.provider.enqueue(
				"root",
				{
					...calls("j4-tg-watch-arm-call", [routineCall("j4-tg-watch-arm")]),
					check: (request) => {
						expect(deliveryWith(request, words), "the owner's words open the run").toContain(ownerHeader);
					},
				},
				{
					name: "j4-tg-watch-arm-answer",
					check: (request) => {
						firstResult = latestBatchResults(request).find((entry) => entry.toolName === "routine");
						requestAnswered.release();
					},
					reply: {
						content: [
							{
								type: "text",
								text: held ? "The watch's check waits for your approval." : "The watch is armed.",
							},
						],
					},
				},
			);
			api.deliver(ownerLegUpdate(1, OWNER_ID, words));
			await withDeadline(trace, "the phone's watch turn", requestAnswered.promise);
			await session.agent.waitForIdle();
			const request = manager
				.getBranch()
				.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes(words),
				);
			expect(request, "the owner's phone message is on the branch").toBeDefined();
			const ownerArmed = { kind: "owner", sourceIds: [`${manager.getSessionId()}/${request?.id}`] };

			if (!held) {
				expect(firstResult?.isError, firstResult?.text).toBe(false);
				await withDeadline(trace, "the watch's first sample", baselineSampled.promise);
				await withDeadline(trace, "the answer reaches the chat", api.untilSent(1));
				expect(store().getRoutine(WATCH_ID)?.armedBy, "armed on the owner's words from the phone").toEqual(
					ownerArmed,
				);
				expect(watchDraft(), "nothing judged the check, so nothing was held").toBeUndefined();
				trace.mark("root", "telegram-watch.armed");
			} else {
				// The check is held for the owner; the watch is not armed and nothing ran.
				expect(store().getRoutine(WATCH_ID), "no watch is armed while its check is held").toBeUndefined();
				const draft = watchDraft();
				expect(draft?.state, "the check waits for the owner").toBe("pending");
				expect(draft?.record.requestEntryId, "the draft names the request it was held in").toBe(request?.id);
				const draftId = draft?.record.id ?? "";
				// The routine call reads the hold as the check's own call would: the held line whole, its tail included,
				// then that nothing was armed and the draft the owner approves.
				expect(firstResult?.isError, "the routine call reports the held check").toBe(true);
				const heldLine = refusalDiagnostic(firstResult?.text ?? "");
				expect(heldLine, "the hold names the watch").toContain(
					`Held for your approval: The check watch "${WATCH_ID}" would run, armed by a routine call: `,
				);
				expect(heldLine, "the held line keeps its tail").toContain(
					", asked from the telegram channel; no grant of the owner covers operation.irreversible.",
				);
				expect(refusalNextAction(firstResult?.text ?? ""), "the routine call names its draft").toContain(
					`Watch "${WATCH_ID}" is not armed: its check's call was refused. It is kept as draft ${draftId}: the owner approves it from the owner channel`,
				);
				// The presentation and the run's answer, the presentation marked shown once its send resolved.
				await withDeadline(trace, "the presentation and the answer reach the chat", api.untilSent(2));
				await withDeadline(
					trace,
					"the presentation is recorded as shown",
					world.io.waitForMutation(() =>
						(journal().ownerPushes ?? []).some((push) => push.c === `telegram:${ownerChat}`),
					),
				);
				const presentation = api.texts().find((text) => text.includes(`draft ${draftId}.`)) ?? "";
				expect(presentation, "the phone is told which watch's check waits").toContain(
					`Held for your decision: The check watch "${WATCH_ID}" would run, armed by a routine call: bash`,
				);
				trace.mark("root", "telegram-watch.held");

				// The approval run repeats the routine call. Its effects are remembered, so only the request is read
				// again; still unsettled, the check goes to the owner once more, and the recorded approval admits it.
				world.systemOne.enterPhase("j4-tg-watch-approval", {
					request_authorizes: { kind: "noul", probability: 0.5 },
				});
				const approvalAnswered = createBarrier();
				let approvedResult: { isError: boolean; text: string } | undefined;
				world.provider.enqueue(
					"root",
					{
						...calls("j4-tg-watch-approved-call", [routineCall("j4-tg-watch-approved")]),
						check: (approval) => {
							expect(
								deliveryWith(
									approval,
									`Owner approval on channel telegram: the owner approved held draft ${draftId}`,
								),
								"the approval turn asks for the routine call that arms the watch",
							).toContain(`Repeat your earlier routine call that arms watch \\"${WATCH_ID}\\"`);
						},
					},
					{
						name: "j4-tg-watch-approved-answer",
						check: (approval) => {
							approvedResult = latestBatchResults(approval).find((entry) => entry.toolName === "routine");
							approvalAnswered.release();
						},
						reply: { content: [{ type: "text", text: "The release watch is armed." }] },
					},
				);
				api.deliver(ownerLegUpdate(2, OWNER_ID, `approve ${draftId}`));
				await withDeadline(trace, "the approval turn", approvalAnswered.promise);
				await session.agent.waitForIdle();
				// Without the request it answers, the approval run has no owner words and the watch would not be saved.
				expect(approvedResult?.isError, approvedResult?.text).toBe(false);
				await withDeadline(trace, "the watch's first sample", baselineSampled.promise);
				await withDeadline(trace, "the approval's reply and answer reach the chat", api.untilSent(4));
				expect(api.texts().slice(2).sort(), "the approval is acknowledged and its turn answers").toEqual(
					[`Approved draft ${draftId}; a turn performs it now.`, "The release watch is armed."].sort(),
				);
				expect(
					store().getRoutine(WATCH_ID)?.armedBy,
					"the watch is armed on the owner's words from the phone that its held check answered",
				).toEqual(ownerArmed);
				expect(watchDraft()?.state, "the approval is spent arming the watch").toBe("released");
				trace.mark("root", "telegram-watch.approved");
			}

			expect(await world.disposeSessionInBody(session), "the watch leg's session closes").toBeUndefined();
			expect(api.openPolls, "closing aborts the held poll").toBe(0);
			expect(api.violations, "every poll acknowledged only journaled updates").toEqual([]);
			expect(
				world.warnings.slice(warningsBefore).filter((warning) => /telegram/i.test(warning)),
				"the watch leg ran without a Telegram warning",
			).toEqual([]);
			trace.mark("root", "telegram-watch.closed");
		});
	} finally {
		scriptedCheck.restore();
	}
}

/** The CI emulation of the CI watch leg: the checkout's repository on GitHub, as the CI source reads it. */
const CI_REPOSITORY: CiRepository = {
	host: "github.com",
	repositoryId: 511,
	nameWithOwner: "harness/repository",
	workflowId: 611,
	workflowPath: ".github/workflows/ci.yml",
};
const CI_RUN_ID = 811;
const CI_RUN_URL = `https://github.com/${CI_REPOSITORY.nameWithOwner}/actions/runs/${CI_RUN_ID}`;
/** The plan the host saves for every watch it arms on what a call started. */
const AUTO_WATCH_ON_FIRE =
	"Read the result. On a failure, inspect the failed job and repair its cause; once it succeeded, continue the work that waited on it. When the deadline passes first, find out why it has not finished.";

/**
 * A push the owner asks for at the terminal arms the session's wait on its CI, and the result reaches the owner's phone
 * once. The session serves the owner's Telegram chat, which it learns from the owner's first phone message; its CI source
 * follows the checkout as the interactive host's CI resource makes it (`ci-session-resource.ts`): the session's watch
 * link follows the CI and the commits its `ci` watches wait on are subjects of the source. The owner's turn runs
 * `git push`, whose report names the pushed commit by its full sha; the host resolves it in the checkout and arms a `ci`
 * watch on it (deadline 60 minutes, told to the owner) and tells the model in one note, which lands at the run's next
 * provider boundary. GitHub's run on that commit then completes with success: the watch fires, its wake opens a turn of
 * the session with GitHub's result, and the phone is told the result once (one `ownerPushes` record for the watch).
 * System One is off for this session: no judgment is declared, and none is asked.
 */
export async function runJourney4TelegramCiWatchPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-telegram-ci-watch`;
	const channelsDir = join(agentDir, "channels");
	const journalPath = join(channelsDir, "telegram.json");
	world.io.mkdirSync(channelsDir, { recursive: true });
	world.io.writeFileSync(join(channelsDir, "telegram.token"), `${TOKEN}\n`, { mode: 0o600 });
	const journal = (): WatchLegJournal =>
		world.io.existsSync(journalPath)
			? (JSON.parse(String(world.io.readFileSync(journalPath))) as WatchLegJournal)
			: { seen: [] };
	const watchPushes = () => (journal().ownerPushes ?? []).filter((push) => push.k.startsWith("push:watch:"));
	const api = new FakeBotApi(() => journal().seen.map((entry) => entry.d));
	const warningsBefore = world.warnings.length;
	const ownerChat = String(OWNER_ID);

	// The commit the owner pushes: the checkout is the repository the owner leg made, one commit ahead of its last.
	const base = world.git.refSha("refs/heads/main");
	expect(base, "the checkout is a repository since the owner leg").toBeDefined();
	expect(
		world.git.run(["commit", "--allow-empty", "-m", "Record the CI watch leg"], HARNESS_PROJECT_CWD).code,
		"the commit the owner pushes",
	).toBe(0);
	const sha = world.git.refSha("refs/heads/main") ?? "";
	expect(sha, "a full sha").toMatch(/^[0-9a-f]{40}$/);
	const watchId = `auto-ci-${sha.slice(0, 12)}`;
	const subject: CiSubject = {
		host: CI_REPOSITORY.host,
		repositoryId: CI_REPOSITORY.repositoryId,
		workflowId: CI_REPOSITORY.workflowId,
		headSha: sha,
	};

	// GitHub's side: the run on the pushed commit is in progress until the leg completes it with success.
	const success: CiAttemptTerminalEvent = createCiAttemptTerminalEvent({
		identity: {
			provider: "github-actions",
			host: CI_REPOSITORY.host,
			repositoryId: CI_REPOSITORY.repositoryId,
			workflowId: CI_REPOSITORY.workflowId,
			runId: CI_RUN_ID,
			runNumber: 1,
			runAttempt: 1,
		},
		headSha: sha,
		conclusion: "success",
		workflowPath: CI_REPOSITORY.workflowPath,
		observedAt: "2026-11-05T00:05:00.000Z",
		runUrl: CI_RUN_URL,
	});
	let collection: CiProviderCollection = {
		subject,
		events: [],
		current: { subject, runId: CI_RUN_ID, runNumber: 1, runAttempt: 1, status: "in_progress" },
	};
	const runCompleted = createBarrier();
	const provider: CiProvider = {
		repository: async () => CI_REPOSITORY,
		collect: async (requestedSha, signal) => {
			signal.throwIfAborted();
			expect(requestedSha, "the source collects only the pushed commit").toBe(sha);
			return collection;
		},
		failedJobs: async () => {
			throw new Error("No CI attempt is red in this leg.");
		},
		waitForRun: async (runId, signal) => {
			expect(runId).toBe(CI_RUN_ID);
			let onAbort = () => {};
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				signal.throwIfAborted();
				await Promise.race([runCompleted.promise, aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
	};
	const gitDir = join(agentDir, "checkout", ".git");
	world.io.mkdirSync(gitDir, { recursive: true });
	world.io.writeFileSync(join(gitDir, "HEAD"), `${sha}\n`);
	const paths: CiGitPaths = {
		root: HARNESS_PROJECT_CWD,
		gitDir,
		commonDir: gitDir,
		statusDir: join(gitDir, "pi-ci"),
	};
	const diagnostics: string[] = [];

	await withFakeBotApi(world, api, async () => {
		const firstPoll = api.nextPoll(undefined);
		const manager = world.createSessionManager(agentDir);
		const created = await world.createRootSession("root", {
			agentDir,
			sessionManager: manager,
			systemOneEnabled: false,
			settings: {
				autoLearn: { enabled: false },
				proactivity: { enabled: false },
				orchestrator: { delegationGate: false },
				routines: { automaticIntake: false },
				channels: { telegram: { mode: "explicit", ownerSenders: [OWNER_ID] } },
			},
		});
		const session: AgentSession = created.session;
		const lanes = session.backgroundLanes;
		await withDeadline(trace, "the CI watch leg's first poll", firstPoll);
		const ledgerDirectory = () => dirname(manager.getSessionFile() ?? "");

		// The owner's first phone message: the session learns the chat its notices go to.
		const phoneWords = "I am pushing main from the terminal";
		const phoneAnswered = createBarrier();
		world.provider.enqueue("root", {
			name: "ci-watch-phone-answer",
			check: (request) => {
				deliveryWith(request, phoneWords);
				phoneAnswered.release();
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		});
		api.deliver(ownerLegUpdate(1, OWNER_ID, phoneWords));
		await withDeadline(trace, "the CI watch leg's phone turn", phoneAnswered.promise);
		await session.agent.waitForIdle();
		await withDeadline(trace, "the phone turn's answer reaches the chat", api.untilSent(1));

		// The CI source of the checkout, as the session's CI resource opens it.
		const watches = lanes.githubWatches;
		const source = await createCiHostRuntime({
			cwd: HARNESS_PROJECT_CWD,
			paths,
			provider,
			store: new CiSourceStore(paths.statusDir),
			onDiagnostic: (message) => diagnostics.push(message),
			getSubscribedSubjects: () => [
				...lanes.getHostEventSubjects(),
				...watches.ciShas().map((headSha) => ({ ...subject, headSha })),
			],
			subscribeSubjects: (listener) => {
				const stops = [lanes.subscribeOrchestrationStore(listener), watches.subscribe(listener)];
				return () => {
					for (const stop of stops) stop();
				};
			},
		});
		if (!source) throw new Error("The CI source of the CI watch leg did not open.");
		const unfollow = watches.followCi();
		const binding = new AbortController();
		await source.source.start(lanes.openHostEventSession(binding.signal).sink);
		trace.mark("root", "telegram-ci-watch.following");

		// The owner's push from the terminal. Its report names the pushed commit by its full sha.
		const pushCommand = "git push origin main";
		const report = `To github.com:${CI_REPOSITORY.nameWithOwner}.git\n   ${base}..${sha}  main -> main\n`;
		if (NATIVE_PLATFORM_SHELL_BY_DEFAULT)
			world.git.enqueueTransport({
				name: "ci-watch-push",
				args: ["push", "origin", "main"],
				cwd: HARNESS_PROJECT_CWD,
				code: 0,
				stdout: "",
				stderr: report,
			});
		else world.shell.enqueue({ name: "ci-watch-push", command: pushCommand, output: report, exitCode: 0 });
		const note = `The host armed watches for what your last bash call started: ${watchId} on the CI of commit ${sha.slice(0, 12)} (deadline in 60 minutes). Each result wakes you and is told to the owner; keep working instead of polling it, and arm no second watch on it.`;
		const carriesNote = (request: ScriptedRequest) => requestTexts(request).some((text) => text.includes(note));
		// The note lands at the run's next provider boundary: the answer's request when the arming came first, else the
		// request after the answer. The answer is held until the note is queued, so the run reads it either way.
		let noteInAnswer = false;
		const answerReached = createBarrier();
		const answerHeld = createBarrier();
		world.provider.enqueue(
			"root",
			calls("ci-watch-push-call", [{ id: "ci-watch-push", name: "bash", arguments: { command: pushCommand } }]),
			{
				name: "ci-watch-push-answer",
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "bash");
					expect(result?.isError, result?.text).toBe(false);
					noteInAnswer = carriesNote(request);
					answerReached.release();
				},
				gate: answerHeld.promise,
				reply: { content: [{ type: "text", text: "Pushed main." }] },
			},
		);
		const pushTurn = session.prompt("Push main.");
		await withDeadline(trace, "the push run's answer is asked", answerReached.promise);
		if (!noteInAnswer) {
			let waiting = true;
			const queued = async () => {
				while (waiting && !session.agent.hasQueuedMessages())
					await new Promise<void>((resolve) => setImmediate(resolve));
			};
			try {
				await withDeadline(trace, "the host's arming note is queued for the push run", queued());
			} finally {
				waiting = false;
			}
			world.provider.enqueue("root", {
				name: "ci-watch-note-answer",
				check: (request) => expect(carriesNote(request), "the run reads the host's note").toBe(true),
				reply: { content: [{ type: "text", text: "The CI of the push is watched." }] },
			});
		}
		answerHeld.release();
		await withDeadline(trace, "the push turn", pushTurn);
		await session.agent.waitForIdle();
		expect(
			NATIVE_PLATFORM_SHELL_BY_DEFAULT ? world.git.reached : world.shell.reached,
			"the owner's push reaches its external boundary",
		).toContain("ci-watch-push");
		const armed = sessionLedgerWatches(ledgerDirectory()).find((watch) => watch.watchId === watchId);
		expect(armed, "the host armed one watch on the pushed commit's CI, told to the owner").toMatchObject({
			condition: { type: "ci", sha },
			onFire: AUTO_WATCH_ON_FIRE,
			armedBy: { kind: "auto" },
			tellOwner: true,
			status: "live",
		});
		expect(armed?.purpose, "the host's arming saves no purpose: its note and wake name the source").toBeUndefined();
		expect(
			manager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === WATCH_AUTO_ARM_CUSTOM_TYPE),
			"the note is saved once",
		).toHaveLength(1);
		trace.mark("root", "telegram-ci-watch.armed");

		// GitHub completes the run: the watch fires, its wake opens a turn and the phone hears the result once.
		const woke = scriptGithubWatchWake(world, "ci-watch", {
			watchId,
			cause: `the CI of commit ${sha.slice(0, 12)} finished: success`,
			planLines: [AUTO_WATCH_ON_FIRE],
			source: { type: "ci", sha },
			result: {
				state: "done",
				status: "completed",
				conclusion: "success",
				url: CI_RUN_URL,
				runId: CI_RUN_ID,
				runAttempt: 1,
			},
		});
		collection = {
			subject,
			events: [success],
			current: {
				subject,
				runId: CI_RUN_ID,
				runNumber: 1,
				runAttempt: 1,
				status: "completed",
				conclusion: "success",
				eventId: success.eventId,
			},
		};
		runCompleted.release();
		await settleWatchWake(world, session, "ci-watch", woke);
		await withDeadline(
			trace,
			"the watch's result is recorded for the phone",
			world.io.waitForMutation(() => watchPushes().length > 0),
		);
		const phoneText = `Watch: the CI of commit ${sha.slice(0, 12)} finished: success.`;
		await withDeadline(
			trace,
			"the watch's result reaches the phone",
			(async () => {
				while (!api.texts().includes(phoneText)) await api.nextSend();
			})(),
		);
		expect(
			api.texts().filter((text) => text === phoneText),
			"the phone hears the result in one sentence",
		).toHaveLength(1);
		expect(sessionWatchOutcome(ledgerDirectory(), watchId), "one firing, its wake delivered").toEqual({
			fires: 1,
			wakes: [["fired", true]],
		});
		trace.mark("root", "telegram-ci-watch.told");

		await source.source.stop();
		binding.abort();
		unfollow();
		expect(await world.disposeSessionInBody(session), "the CI watch leg's session closes").toBeUndefined();
		const told = watchPushes();
		expect(told, "the owner's phone was told the watch's result exactly once").toHaveLength(1);
		expect(told[0]?.k.startsWith(`push:watch:${watchId}:`), told[0]?.k).toBe(true);
		expect(told[0]?.c, "on the owner's chat").toBe(`telegram:${ownerChat}`);
		expect(api.openPolls, "closing aborts the held poll").toBe(0);
		expect(api.violations, "every poll acknowledged only journaled updates").toEqual([]);
		trace.mark("root", "telegram-ci-watch.closed");
	});
	expect(diagnostics, "the CI source reported nothing").toEqual([]);
	expect(world.warnings.slice(warningsBefore), "the CI watch leg warned of nothing").toEqual([]);
}
