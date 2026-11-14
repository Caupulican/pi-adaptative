import { join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { outwardDraftStates } from "../../../../src/core/agent-session-edge.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { deliveryWith, FakeBotApi, OWNER_ID, ownerLegUpdate, TOKEN } from "./journey-4-telegram.ts";
import { scriptRequirementCheckSpawn } from "./journey-9-shared.ts";
import { ICM_INTAKE_JUDGMENTS, latestBatchResults } from "./shared.ts";

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
	world.fetchResponder = (input, init) => api.respond(input, init);
	const warningsBefore = world.warnings.length;
	const ownerChat = String(OWNER_ID);
	const ownerHeader = "Owner message on channel telegram (verified private chat, 1 message";
	// Each check of the watched command is a requirement-check process: the world's shell answers that command line.
	const scriptedCheck = scriptRequirementCheckSpawn(world, WATCH_COMMAND);
	try {
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
		// submission order; no grant is standing, so whether they grant one is asked too). System One cannot read what
		// the project script does: whether it changes files outside the task or cannot be undone stays unsettled (above
		// the effect family's 0.5 absence cut, below its 0.8 presence), and the request does not settle it (between 0.2
		// and 0.8), so the check goes to the owner.
		world.systemOne.enterPhase("j4-tg-watch-request", {
			...ICM_INTAKE_JUDGMENTS,
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
						{ type: "text", text: held ? "The watch's check waits for your approval." : "The watch is armed." },
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
			expect(store().getRoutine(WATCH_ID)?.armedBy, "armed on the owner's words from the phone").toEqual(ownerArmed);
			expect(watchDraft(), "nothing judged the check, so nothing was held").toBeUndefined();
			trace.mark("root", "telegram-watch.armed");
		} else {
			// The check is held for the owner; the watch is not armed and nothing ran.
			expect(firstResult?.isError, "the routine call reports the held check").toBe(true);
			expect(firstResult?.text).toContain("The check this watch would make was refused: Held for your approval: ");
			expect(firstResult?.text, "the hold names the watch").toContain(`The check watch "${WATCH_ID}" would run`);
			expect(firstResult?.text).toContain("It is kept as draft draft-");
			expect(store().getRoutine(WATCH_ID), "no watch is armed while its check is held").toBeUndefined();
			const draft = watchDraft();
			expect(draft?.state, "the check waits for the owner").toBe("pending");
			expect(draft?.record.requestEntryId, "the draft names the request it was held in").toBe(request?.id);
			const draftId = draft?.record.id ?? "";
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
	} finally {
		scriptedCheck.restore();
		world.fetchResponder = undefined;
	}
}
