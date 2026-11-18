/** The phone follows a desktop schedule across daemon takeover, an interrupted machine link and desktop handback. */
import { join } from "node:path";
import { expect } from "vitest";
import { botTeamStoreFile, configFile } from "../../../../src/core/agent-paths.ts";
import { readRemoteBotHost } from "../../../../src/core/bots/bot-host-state.ts";
import { OWED_INBOX_SWEEP_MS } from "../../../../src/core/bots/bot-session-owed-work.ts";
import { createBuiltInChannelProvider } from "../../../../src/core/channels/built-in-providers.ts";
import { ChannelJournal } from "../../../../src/core/channels/channel-journal.ts";
import { DAEMON_TICK_MS } from "../../../../src/core/delegation/bot-daemon.ts";
import { FleetMachines } from "../../../../src/core/remote/fleet-machines.ts";
import { linkHostOwner, RUNNER_LOCK } from "../../../../src/core/remote/host-lock.ts";
import { enrollJoin, renameIdentity } from "../../../../src/core/remote/registry.ts";
import { readRoutineBotJobResults, routineJobStatusLines } from "../../../../src/core/remote/routine-job-results.ts";
import { formatRoutineList } from "../../../../src/modes/interactive/bot-team-lines.ts";
import { createBarrier, HARNESS_PROVIDER } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, SCRIPTED_TRACKS, withDeadline } from "../session-fixture.ts";
import { FakeBotApi, OWNER_ID, ownerLegUpdate, TOKEN, withFakeBotApi } from "./journey-4-telegram.ts";
import { createOwnerBot, enqueueBot } from "./journey-7-shared.ts";
import {
	enqueueJoinerJob,
	joinerJobReached,
	planCallSteps,
	planUpdateStep,
	reportStep,
	whenMachine,
	writeRemoteSettings,
} from "./journey-10-shared.ts";
import { currentRequestCarries, flushedSessionManager } from "./shared.ts";

export async function awayScheduledJob(world: HarnessWorld): Promise<void> {
	const hubDir = `${world.agentDir}-away-hub`;
	const peerDir = `${world.agentDir}-away-peer`;
	const hubName = "away-hub";
	const peerName = "away-peer";
	const bot = "limits-inspector";
	const routineId = "daily-limits";
	const soul = "You inspect the retry limit on the owner's other machine.";
	const summary = "The paired checkout permits three retries.";
	const peerId = renameIdentity(peerDir, peerName).machineId;
	renameIdentity(hubDir, hubName);
	const settings = {
		memorySystem: "okf" as const,
		autoLearn: { enabled: false },
		proactivity: { enabled: false },
		orchestrator: { delegationGate: false },
		routines: { maxResultWakesPerDay: 0, away: { enabled: true, autostart: "off" as const } },
		channels: { telegram: { mode: "explicit" as const, ownerSenders: [OWNER_ID], awayCwd: HARNESS_PROJECT_CWD } },
	};
	world.io.seed(
		configFile(hubDir, "settings.json"),
		JSON.stringify({
			...settings,
			defaultProvider: HARNESS_PROVIDER,
			defaultModel: "root",
			modelFavorites: SCRIPTED_TRACKS.map((modelId) => ({ provider: HARNESS_PROVIDER, modelId })),
			systemOne: { enabled: false },
		}),
	);
	const channels = join(hubDir, "channels");
	world.io.mkdirSync(channels, { recursive: true });
	world.io.writeFileSync(join(channels, "telegram.token"), TOKEN, { mode: 0o600 });
	const journal = new ChannelJournal(hubDir, "telegram");
	const api = new FakeBotApi(() => journal.read().result.seen.map((item) => item.d));
	const wait = <T>(description: string, result: Promise<T>) => withDeadline(world.trace, description, result);
	const phone = async (id: number, words: string) => {
		const sent = api.nextSend();
		api.deliver(ownerLegUpdate(id, OWNER_ID, words));
		await wait(words, sent);
		return api.texts().at(-1);
	};
	world.systemOne.enterPhase("j10-closed-desktop", {});
	await withFakeBotApi(world, api, async () => {
		const launched = world.processes.runNextBotDaemon({ channelProviders: createBuiltInChannelProvider });
		const polling = api.nextPoll(undefined);
		const manager = flushedSessionManager(world, hubDir);
		const open = await world.createRootSession("root", {
			agentDir: hubDir,
			sessionManager: manager,
			settings,
			systemOneEnabled: false,
		});
		await wait("desktop serves Telegram and starts the daemon", Promise.all([launched, polling]));
		const hub = open.session.backgroundLanes.getRemoteHub();
		const address = "127.0.0.1";
		const port = await hub.listen(address, 0);
		const invite = hub.add(peerName);
		enrollJoin(peerDir, invite.address, invite.token);
		writeRemoteSettings(world, peerDir, { repos: [{ path: HARNESS_PROJECT_CWD, ready: true }], jobRoom: 1 });
		const peer = await world.createRootSession("worker-b", {
			agentDir: peerDir,
			sessionManager: world.createSessionManager(peerDir),
			systemOneEnabled: false,
			settings: {
				...settings,
				channels: { link: { mode: "explicit", allowedSenders: [hubName], replyMode: "auto" } },
			},
		});
		await peer.session.backgroundLanes.getRemoteHub().start();
		const ready = (row: ReturnType<FleetMachines["list"]>[number]) =>
			row.machineId === peerId && row.online && row.facts?.accepts.jobs === true && row.facts.checkouts.length === 1;
		await wait("desktop pairs with the read-only executor", whenMachine(hub.jobs!, ready));
		createOwnerBot(open.session, bot, "worker-c", soul);
		const savedAt = open.session.backgroundLanes.captureBotScheduleOrigin();
		const store = open.session.getBotTeamStore();
		const schedule = store.upsertRoutine({
			routineId,
			...savedAt,
			nowMs: world.timers.port("routines").now(),
			target: { kind: "bot", agentId: bot },
			prompt: "Use a plan to read the paired machine's retry limit.",
			schedule: { kind: "interval", intervalMs: DAEMON_TICK_MS * 4 },
		});
		expect(await phone(1, `select ${bot} ${routineId}`)).toContain(routineId);
		expect(await world.disposeSessionInBody(open.session)).toBeUndefined();
		world.timers.advance("routines", DAEMON_TICK_MS);
		await wait(
			"daemon serves the same phone after the desktop closes",
			world.io.waitForMutation(() => journal.read().result.holder?.away === true),
		);
		const fleet = new FleetMachines(hubDir);
		await wait(
			"the paired machine reconnects to the detached daemon",
			world.io.waitForMutation(() => fleet.list().some(ready)),
		);
		expect(linkHostOwner(hubDir)?.away).toBe(true);
		expect(linkHostOwner(hubDir, RUNNER_LOCK)).toBeUndefined();
		expect(await phone(2, "status")).toContain(routineId);
		const executing = createBarrier();
		const release = createBarrier();
		const completed = createBarrier();
		const calls = planCallSteps(
			"away-limits",
			{
				action: "start",
				title: "Inspect the paired checkout",
				steps: [
					{
						id: "inspect",
						by: `machine:${peerId}`,
						do: "[j10-job:away] Read the retry limit in src/limits.ts. Change no file.",
					},
				],
			},
			"PLAN_STARTED",
			() => {},
		);
		enqueueBot(
			world,
			"j10-away-bot",
			"worker-c",
			soul,
			...calls,
			planUpdateStep("away-settled", "PLAN_DONE", completed.release),
		);
		enqueueJoinerJob(
			world,
			"away",
			reportStep("away-report", { status: "completed", summary }, release.promise, executing.release),
		);
		const rootCalls = () => world.provider.requests.filter((request) => request.model.id === "root").length;
		const before = rootCalls();
		try {
			world.timers.advance("routines", DAEMON_TICK_MS * 3);
			await wait(
				"clock slot reaches the durable bot inbox",
				world.io.waitForMutation(
					() => world.io.peekFile(botTeamStoreFile(hubDir))?.includes(`Prompt accepted by bot ${bot}`) === true,
				),
			);
			world.timers.advance("bot-sessions", OWED_INBOX_SWEEP_MS);
			await wait("the scheduled bot places its job with every coordinator terminal closed", executing.promise);
			expect(readRemoteBotHost(hubDir, bot, "journey-observer")?.hostKind).toBe("daemon");
			const offline = world.io.waitForMutation(() =>
				fleet.list().some((row) => row.machineId === peerId && !row.online),
			);
			world.network!.disconnectClients(address, port);
			await wait("link drops while the worker holds its result", offline);
			await wait(
				"daemon reconnects the executor on the same port",
				world.io.waitForMutation(() => fleet.list().some(ready)),
			);
			release.release();
			await wait("the scheduled bot receives the remote result", completed.promise);
			const status = await phone(3, "status");
			expect(status).toContain(summary);
			const steer = "Summarize the completed retry inspection.";
			const answer = "The retry budget is three.";
			enqueueBot(world, "j10-away-bot", "worker-c", soul, {
				name: "away-phone-followup",
				check: (request) => expect(currentRequestCarries(request, steer)).toBe(true),
				reply: { content: [{ type: "text", text: answer }] },
			});
			expect(await phone(4, `steer ${steer}`)).toContain("Steering queued");
			world.timers.advance("bot-sessions", OWED_INBOX_SWEEP_MS);
			await wait(
				"the daemon settles the phone follow-up in the saved project",
				world.io.waitForMutation(
					() =>
						journal
							.read()
							.result.ownerTaskCommands?.some(
								(command) =>
									command.action === "steer" &&
									command.projectBound &&
									command.cwd === savedAt.botProjectCwd &&
									command.state === "finished" &&
									command.reply?.includes(answer),
							) === true,
				),
			);
			expect(await phone(5, "stop task")).toContain(`Paused task ${routineId}`);
			expect(rootCalls()).toBe(before);
			const returning = await world.createRootSession("root", {
				agentDir: hubDir,
				sessionManager: world.openSessionManager(manager.getSessionFile()!, hubDir),
				settings,
				systemOneEnabled: false,
			});
			const returnedHub = returning.session.backgroundLanes.getRemoteHub();
			await returnedHub.start();
			world.timers.advance("routines", DAEMON_TICK_MS);
			await wait(
				"desktop resumes custody on the same port after peer reconnect",
				world.io.waitForMutation(() => returnedHub.status().listening?.port === port && fleet.list().some(ready)),
			);
			const observed = returning.session.getBotTeamStore();
			observed.reload(true);
			expect(observed.getRoutine(routineId)).toMatchObject({
				enabled: false,
				incarnationId: schedule.incarnationId,
			});
			const history = observed.listRoutineOccurrences({ routineId });
			expect(history).toHaveLength(1);
			expect(history[0]).toMatchObject({
				executor: "away",
				phase: "terminal",
				parentOrigin: savedAt.receiptOrigin,
				definition: { incarnationId: schedule.incarnationId },
			});
			const results = readRoutineBotJobResults(hubDir, history[0]!);
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ machine: peerName, summary });
			expect(status).toContain(results[0]!.jobId);
			const desktop = formatRoutineList([observed.getRoutine(routineId)!], undefined, (row) =>
				routineJobStatusLines(observed, row),
			);
			expect(desktop).toContain(results[0]!.jobId);
			expect(desktop).toContain(summary);
			expect(world.provider.reached.filter((step) => step === joinerJobReached("away", "away-report"))).toHaveLength(
				1,
			);
		} finally {
			release.release();
		}
	});
}
