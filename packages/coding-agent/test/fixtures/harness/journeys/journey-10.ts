import "../builtin-install.ts";
import { expect } from "vitest";
import { configFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type { PlanNodeSpec } from "../../../../src/core/plan/plan-graph.ts";
import { placementFor } from "../../../../src/core/plan/plan-placement.ts";
import { recordPeerDown, recordPeerFacts, recordPeerUp } from "../../../../src/core/remote/fleet-machines.ts";
import type { RemoteJobEvent } from "../../../../src/core/remote/job-client.ts";
import { CAP_FEATURE, JOBS_FEATURE } from "../../../../src/core/remote/job-protocol.ts";
import {
	type ExecutorJobRecord,
	inDir,
	JobStore,
	outDir,
	type PlacerJobRecord,
} from "../../../../src/core/remote/job-store.ts";
import { LinkClient, type LinkState } from "../../../../src/core/remote/link-client.ts";
import { hubMachinesFor } from "../../../../src/core/remote/link-context.ts";
import { REFUSAL_TEXT } from "../../../../src/core/remote/protocol.ts";
import {
	DEFAULT_OFFLINE_HOLD_MS,
	listHubMachines,
	loadIdentity,
	parseJoinToken,
	renameIdentity,
	saveJoin,
	updateLinkPeerSettings,
} from "../../../../src/core/remote/registry.ts";
import { RemoteJobs } from "../../../../src/core/remote/remote-jobs.ts";
import { resolveRepoIdentity } from "../../../../src/core/remote/repo-identity.ts";
import { SEALED_FEATURE } from "../../../../src/core/remote/session-keys.ts";
import { DirectoryWatch } from "../../../../src/core/remote/store-watch.ts";
import { THIRD_PARTY_MEMORY_WITHHELD } from "../../../../src/core/system-prompt-builder.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import {
	batchResultById,
	enqueueHubRoot,
	enqueueHubStepWorker,
	enqueueJoinerChannel,
	enqueueJoinerJob,
	HUB_MACHINE_NAME,
	HUB_ROOT_TRACK,
	INTAKE_JUDGMENTS,
	JOINER_CHANNEL_TRACK,
	JOINER_MACHINE_NAME,
	JOINER_OWNER_SECRET_MEMORY,
	joinerJobReached,
	LIMITS_CONTENT,
	LIMITS_REL_PATH,
	latestAttemptOf,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	ROGUE_MACHINE_NAME,
	reportStep,
	SERVICE_DOC_CONTENT,
	SERVICE_DOC_REL_PATH,
	whenLaneRecords,
	whenMachine,
	writeRemoteSettings,
} from "./journey-10-shared.ts";
import { currentRequestCarries, runJourney } from "./shared.ts";

const JOURNEY_10_BUDGET_MS = 340_000;

async function waitForExecutorJob(
	trace: HarnessWorld["trace"],
	label: string,
	agentDir: string,
	predicate: (record: ExecutorJobRecord) => boolean,
): Promise<ExecutorJobRecord> {
	const store = new JobStore(agentDir);
	const initial = store.in.list().find(predicate);
	if (initial) return initial;
	let watch: DirectoryWatch | undefined;
	try {
		return await withDeadline(
			trace,
			label,
			new Promise<ExecutorJobRecord>((resolve) => {
				watch = new DirectoryWatch([inDir(agentDir)], () => {
					const matched = store.in.list().find(predicate);
					if (matched) resolve(matched);
				});
				watch.start();
				const raced = store.in.list().find(predicate);
				if (raced) resolve(raced);
			}),
		);
	} finally {
		watch?.stop();
	}
}

async function waitForPlacerJob(
	trace: HarnessWorld["trace"],
	label: string,
	agentDir: string,
	predicate: (record: PlacerJobRecord) => boolean,
): Promise<PlacerJobRecord> {
	const store = new JobStore(agentDir);
	const initial = store.out.list().find(predicate);
	if (initial) return initial;
	let watch: DirectoryWatch | undefined;
	try {
		return await withDeadline(
			trace,
			label,
			new Promise<PlacerJobRecord>((resolve) => {
				watch = new DirectoryWatch([outDir(agentDir)], () => {
					const matched = store.out.list().find(predicate);
					if (matched) resolve(matched);
				});
				watch.start();
				const raced = store.out.list().find(predicate);
				if (raced) resolve(raced);
			}),
		);
	} finally {
		watch?.stop();
	}
}

function textBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block
				? [String(block.text)]
				: [],
		)
		.join("\n");
}

async function runTimedOfflineHoldWitness(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDirTimed = `${world.agentDir}-timed`;
	renameIdentity(agentDirTimed, "timed-hub");
	const timedCreated = await world.createRootSession("root", {
		agentDir: agentDirTimed,
		sessionManager: world.createSessionManager(agentDirTimed),
	});
	const sessionTimed = timedCreated.session;
	const timerPort = world.timers.port("orchestration");
	const timedJobs = new RemoteJobs(
		agentDirTimed,
		() => loadIdentity(agentDirTimed),
		{
			session: sessionTimed.backgroundLanes,
			sessionId: () => sessionTimed.sessionId,
			cwd: () => HARNESS_PROJECT_CWD,
			models: () => [],
			usesSubscription: () => false,
			timers: timerPort,
		},
		() => {},
	);
	try {
		timedJobs.start();
		const peerId = "peer-offline-witness-01";
		recordPeerUp(agentDirTimed, { machineId: peerId, name: "offline-box", role: "joiner" });
		recordPeerFacts(agentDirTimed, peerId, {
			os: "linux",
			arch: "x64",
			shell: "posix",
			checkouts: [],
			tools: ["git", "node"],
			models: [{ provider: "harness-scripted", modelClass: "worker-b", access: "api", headroom: "unknown" }],
			room: 1,
			accepts: { jobs: true, writes: false, leader: false },
			capRev: 1,
		});
		timedJobs.machines.notify();

		const placed = await timedJobs.place(
			peerId,
			{ idempotencyKey: "j10-timed-offline-hold", instructions: "Answer status check without repo." },
			{ deadlineMs: 3_600_000 },
		);
		expect(placed.kind, "timer-wired RemoteJobs places the pending job").toBe("placed");
		if (placed.kind !== "placed") throw new Error("Expected placed handle");

		const endedBarrier = createBarrier();
		let endedRecord: PlacerJobRecord | undefined;
		const unsubscribe = placed.handle.subscribe((event: RemoteJobEvent) => {
			if (event.kind !== "ended") return;
			endedRecord = event.record;
			endedBarrier.release();
		});
		const timedWake = createBarrier();
		enqueueHubRoot(world, {
			name: "j10-timed-offline-wake",
			check: (request) => {
				expect(currentRequestCarries(request, placed.handle.laneId)).toBe(true);
				timedWake.release();
			},
			reply: { content: [{ type: "text", text: "Offline hold expiry noted." }] },
		});

		try {
			recordPeerDown(agentDirTimed, peerId, timerPort.now());
			timedJobs.machines.notify();
			// Before the offline hold elapses on the injected TimerPort, the job remains pending.
			world.timers.advance("orchestration", DEFAULT_OFFLINE_HOLD_MS - 5_000);
			expect(endedRecord, "job stays held while inside offlineHoldMs").toBeUndefined();

			// Crossing DEFAULT_OFFLINE_HOLD_MS on world.timers fires the hold alarm deterministically.
			world.timers.advance("orchestration", 10_000);
			await withDeadline(trace, "J10 timed offline hold ends placed job", endedBarrier.promise);
			await withDeadline(trace, "J10 timed session foreground wake", timedWake.promise);
			await withDeadline(trace, "J10 timed session idle", sessionTimed.waitForForegroundIdle());
			expect({
				state: endedRecord?.state,
				ending: endedRecord?.ending,
				applied: endedRecord?.appliedAt !== undefined,
			}).toEqual({
				state: "ended",
				ending: "machine_offline",
				applied: true,
			});
		} finally {
			unsubscribe();
		}
	} finally {
		timedJobs.dispose();
		expect(await world.disposeSessionInBody(sessionTimed), "timed witness session disposes cleanly").toBeUndefined();
	}
}

async function runJourney10Body(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const warningsBefore = world.warnings.length;
	const fleet = world.settingsManager.getGlobalSettings().fleet ?? {};
	world.settingsManager.setFleetSettings({ ...fleet, ceiling: { ...fleet.ceiling, running: 4 } });

	const agentDirHub = `${world.agentDir}-hub`;
	const agentDirJoiner = `${world.agentDir}-joiner`;
	const hubIdentity = renameIdentity(agentDirHub, HUB_MACHINE_NAME);
	const joinerIdentity = renameIdentity(agentDirJoiner, JOINER_MACHINE_NAME);
	world.io.seed(configFile(agentDirJoiner, "MEMORY.md"), `${JOINER_OWNER_SECRET_MEMORY}\n`);

	const hubManager = world.createSessionManager(agentDirHub);
	const joinerManager = world.createSessionManager(agentDirJoiner);
	const { session: sessionHub } = await world.createRootSession("root", {
		agentDir: agentDirHub,
		sessionManager: hubManager,
	});
	const hub = sessionHub.backgroundLanes.getRemoteHub();
	let sessionJoiner: AgentSession | undefined;

	try {
		// ---- Leg 1: Pairing, Mutual-Auth sealed/1 + cap/1 + jobs/1, Capabilities & Replay Rejection ----
		const port = await hub.listen("127.0.0.1", 0);
		expect(port, "ephemeral TCP port allocated on VirtualNetwork").toBeGreaterThanOrEqual(40_000);
		expect(hub.status().listening).toEqual({ host: "127.0.0.1", port });

		const { token } = hub.add(JOINER_MACHINE_NAME);
		const parsedToken = parseJoinToken(token);
		expect(parsedToken).toMatchObject({ hubName: HUB_MACHINE_NAME, name: JOINER_MACHINE_NAME });
		if (!parsedToken) throw new Error("Join token failed to parse");

		const hubAddress = `127.0.0.1:${port}`;
		saveJoin(agentDirJoiner, {
			address: hubAddress,
			name: parsedToken.name,
			hubName: parsedToken.hubName,
			secret: parsedToken.secret,
		});
		writeRemoteSettings(world, agentDirJoiner, {
			requireSealed: true,
			repos: [{ path: HARNESS_PROJECT_CWD, ready: true }],
			jobRoom: 2,
		});

		sessionJoiner = (
			await world.createRootSession("worker-b", {
				agentDir: agentDirJoiner,
				sessionManager: joinerManager,
				settings: {
					memorySystem: "okf",
					autoLearn: { enabled: false },
					proactivity: { enabled: false },
					channels: {
						link: { mode: "explicit", allowedSenders: [HUB_MACHINE_NAME], replyMode: "auto" },
					},
				},
			})
		).session;
		const joinerHub = sessionJoiner.backgroundLanes.getRemoteHub();
		expect(await joinerHub.start()).toBeUndefined();

		const repoIdentity = await resolveRepoIdentity(HARNESS_PROJECT_CWD);
		expect(repoIdentity?.repoKey).toMatch(/^[0-9a-f]{64}$/);
		const joinerMachine = await withDeadline(
			trace,
			"J10 leg 1: joiner capability advert reaches hub",
			whenMachine(
				hub.jobs!,
				(m) =>
					m.name === JOINER_MACHINE_NAME &&
					m.online &&
					m.facts?.accepts.jobs === true &&
					m.facts.checkouts.length === 1,
			),
		);

		expect(hub.list()).toMatchObject([{ name: JOINER_MACHINE_NAME, connected: true, sealed: true, revoked: false }]);
		const liveLinkState = hubMachinesFor(agentDirHub)[joinerIdentity.machineId];
		expect(liveLinkState?.features).toEqual(expect.arrayContaining([SEALED_FEATURE, CAP_FEATURE, JOBS_FEATURE]));
		expect(joinerMachine).toMatchObject({
			machineId: joinerIdentity.machineId,
			name: JOINER_MACHINE_NAME,
			online: true,
			facts: {
				room: 2,
				accepts: { jobs: true, writes: false, leader: false },
				checkouts: [{ repoKey: repoIdentity?.repoKey, ready: true }],
			},
		});
		expect(hub.rosterWords(JOINER_MACHINE_NAME)).toEqual({ state: "idle", currentSummary: "ready, 2 free" });
		expect(
			listHubMachines(agentDirHub).find((m) => m.name === JOINER_MACHINE_NAME)?.machineId,
			"first handshake binds the one-time token slot to joiner's machineId",
		).toBe(joinerIdentity.machineId);

		// Second replay of the same one-time join token from a distinct machine identity is rejected.
		const rogueIdentity = renameIdentity(`${world.agentDir}-rogue`, ROGUE_MACHINE_NAME);
		const rogueDone = createBarrier();
		const rogueStates: LinkState[] = [];
		const rogueClient = new LinkClient({
			join: {
				address: hubAddress,
				name: parsedToken.name,
				hubName: parsedToken.hubName,
				secret: parsedToken.secret,
			},
			identity: rogueIdentity,
			requireSealed: () => true,
			events: {
				state: (state) => {
					rogueStates.push(state);
					if (state.state === "waiting") rogueDone.release();
				},
				message: () => {},
			},
		});
		try {
			rogueClient.start();
			await withDeadline(trace, "J10 leg 1: rogue replay refused", rogueDone.promise);
		} finally {
			rogueClient.stop();
		}
		expect(rogueStates, "rogue replay never reaches connected and is refused as machine_changed").toEqual([
			{ state: "waiting", reason: REFUSAL_TEXT.machine_changed },
		]);
		expect(
			listHubMachines(agentDirHub).find((m) => m.name === JOINER_MACHINE_NAME)?.machineId,
			"token slot stays bound to the legitimate joiner",
		).toBe(joinerIdentity.machineId);
		trace.mark("root", "j10.leg1-paired-and-replay-refused");

		// ---- Leg 2: Direct Placed Read-Only Job + Privacy + Silent Joiner Foreground ----
		world.systemOne.enterPhase("j10-leg2-placed-job", {});
		const joinerMessagesBeforeJob = sessionJoiner.messages.length;
		const joinerChannelMark = world.provider.reached.filter((k) => k.startsWith(`${JOINER_CHANNEL_TRACK}:`)).length;
		const directSummary = "Service doc inspection: retry ceiling is 3 attempts with 250ms backoff.";

		enqueueJoinerJob(
			world,
			"direct-read",
			{
				...calls("j10-direct-read-calls", [
					{ id: "j10-read-doc", name: "read", arguments: { path: projectPath("docs", "service.md") } },
					{
						id: "j10-read-secret-memory",
						name: "read",
						arguments: { path: configFile(agentDirJoiner, "MEMORY.md") },
					},
					{
						id: "j10-bash-write-refused",
						name: "bash",
						arguments: { command: "echo pwn > docs/pwn.txt" },
					},
				]),
				check: (request) => {
					expect(
						request.context.systemPrompt,
						"Joiner owner MEMORY.md never enters worker system prompt",
					).not.toContain(JOINER_OWNER_SECRET_MEMORY);
					expect(request.context.systemPrompt, "worker prompt omits root memory section altogether").not.toContain(
						THIRD_PARTY_MEMORY_WITHHELD,
					);
					const toolNames = (request.context.tools ?? []).map((t) => t.name).sort();
					expect(toolNames, "placed job receives read-only inspection surface + submit_report").toEqual(
						expect.arrayContaining(["bash", "find", "grep", "ls", "read", "repo_read", "submit_report"]),
					);
					for (const forbidden of [
						"write",
						"edit",
						"python",
						"run_process",
						"memory",
						"memory_read",
						"chat_date",
						"chat_zoom",
						"bot",
						"bot_message",
						"delegate",
						"assign",
						"plan",
						"goal",
					]) {
						expect(toolNames, `placed job never receives ${forbidden}`).not.toContain(forbidden);
					}
					const delivered = JSON.stringify(request.context.messages);
					expect(delivered).toContain(`machine ${HUB_MACHINE_NAME}`);
					expect(delivered).toContain("Your file reads reach only the project checkout offered for this job.");
				},
			},
			reportStep("j10-direct-read-report", { status: "completed", summary: directSummary }, undefined, (request) => {
				const docRead = batchResultById(request, "j10-read-doc");
				const memoryRead = batchResultById(request, "j10-read-secret-memory");
				const bashWrite = batchResultById(request, "j10-bash-write-refused");
				expect(docRead?.isError, `docRead failed: ${docRead?.text}`).toBe(false);
				expect(docRead?.text).toContain("Retry ceiling is 3 attempts with 250ms backoff.");
				expect(memoryRead?.isError, "reads outside offered checkout are refused").toBe(true);
				expect(memoryRead?.text).not.toContain(JOINER_OWNER_SECRET_MEMORY);
				expect(bashWrite?.isError, "read-only shell refuses mutation inside placed job").toBe(true);
			}),
		);

		const directWake = createBarrier();
		let directWakeRequest: Parameters<NonNullable<Parameters<typeof enqueueHubRoot>[1]["check"]>>[0] | undefined;
		enqueueHubRoot(world, {
			name: "j10-direct-job-wake",
			check: (request) => {
				directWakeRequest = request;
				expect(currentRequestCarries(request, "succeeded")).toBe(true);
				directWake.release();
			},
			reply: { content: [{ type: "text", text: "Received joiner's read-only inspection." }] },
		});

		const checkoutCwd = await hub.jobs!.projectOn(joinerMachine.machineId);
		expect(checkoutCwd).toBe(HARNESS_PROJECT_CWD);
		const placedDirect = await hub.jobs!.place(
			joinerMachine.machineId,
			{
				idempotencyKey: "j10-direct-service-doc",
				instructions: "[j10-job:direct-read] Read docs/service.md and summarize the retry ceiling.",
			},
			{ cwd: checkoutCwd, label: "Inspect service retry ceiling" },
		);
		expect(placedDirect.kind).toBe("placed");
		if (placedDirect.kind !== "placed") throw new Error("Direct job placement refused");

		const observedPhases: string[] = [];
		const directEnded = createBarrier();
		let directPlacerRecord: PlacerJobRecord | undefined;
		const unsubDirect = placedDirect.handle.subscribe((event: RemoteJobEvent) => {
			if (event.kind === "progress") observedPhases.push(event.phase);
			if (event.kind === "ended") {
				directPlacerRecord = event.record;
				directEnded.release();
			}
		});
		try {
			await withDeadline(trace, "J10 leg 2: direct job outcome applied", directEnded.promise);
			await withDeadline(trace, "J10 leg 2: hub foreground notified", directWake.promise);
			await withDeadline(trace, "J10 leg 2: hub foreground idle", sessionHub.waitForForegroundIdle());
		} finally {
			unsubDirect();
		}

		expect(
			directWakeRequest && currentRequestCarries(directWakeRequest, placedDirect.handle.laneId),
			"Hub foreground wakes with compact handoff for the placed remote lane",
		).toBe(true);

		expect(observedPhases.length, "progress frames streamed over jobs/1").toBeGreaterThanOrEqual(1);
		expect(directPlacerRecord?.state).toBe("terminal");
		expect(directPlacerRecord?.outcome).toMatchObject({ status: "succeeded", summary: directSummary });
		expect(sessionJoiner.isStreaming, "Joiner foreground never streams on placed job").toBe(false);
		expect(
			sessionJoiner.messages.length,
			`Joiner foreground stays completely silent: ${JSON.stringify(sessionJoiner.messages)}`,
		).toBe(joinerMessagesBeforeJob);
		expect(
			world.provider.reached.filter((k) => k.startsWith(`${JOINER_CHANNEL_TRACK}:`)).length,
			"placed job never triggers a channel turn on Joiner",
		).toBe(joinerChannelMark);
		trace.mark("root", "j10.leg2-placed-readonly-job");

		// ---- Leg 3a: Open-Gate Plan Remote Placement ----
		const openPlanTitle = "Survey limits on joiner when gate is open";
		const openStarted = createBarrier();
		const openDone = createBarrier();
		let openDonePayload = "";
		enqueueJoinerJob(
			world,
			"plan-open",
			reportStep("j10-plan-open-report", {
				status: "completed",
				summary: "Remote plan step read limits: MAX_RETRIES = 3.",
			}),
		);
		enqueueHubRoot(
			world,
			...planCallSteps(
				"j10-plan-open",
				{
					action: "start",
					title: openPlanTitle,
					steps: [
						{
							id: "remote-survey",
							by: `machine:${joinerMachine.machineId}`,
							do: "[j10-job:plan-open] Read src/limits.ts and report MAX_RETRIES. Change no file.",
						},
					],
				},
				"PLAN_STARTED",
				() => openStarted.release(),
			),
			planUpdateStep("j10-plan-open-done", "PLAN_DONE", (request) => {
				openDonePayload = JSON.stringify(request.context.messages);
				openDone.release();
			}),
		);
		world.systemOne.enterPhase("j10-leg3-open", PLAN_CALL_JUDGMENTS);
		await withDeadline(trace, "J10 leg 3a: start open-gate plan", sessionHub.prompt("Survey limits on joiner-box."));
		await withDeadline(trace, "J10 leg 3a: plan started", openStarted.promise);
		await withDeadline(trace, "J10 leg 3a: plan finished", openDone.promise);
		await withDeadline(trace, "J10 leg 3a: hub idle", sessionHub.waitForForegroundIdle());

		const openPlan = planTitled(sessionHub, openPlanTitle);
		const openRemoteTaskId = openPlan.nodes["remote-survey"]?.release?.taskId ?? "";
		const openRemoteJobId = openRemoteTaskId.replace(/^remote-/, "").replace(/:turn:\d+$/, "");
		const openPlacerRecord = await waitForPlacerJob(
			trace,
			"J10 leg 3a: open-gate plan placer record applied",
			agentDirHub,
			(r) => r.jobId === openRemoteJobId && r.appliedAt !== undefined,
		);
		expect({
			closed: openPlan.closed?.status,
			placement: openPlan.nodes["remote-survey"]?.release?.placement,
			exit: openPlan.nodes["remote-survey"]?.release?.exit,
			remoteTask: openRemoteTaskId.startsWith("remote-"),
			deliveredOutcome: openDonePayload.includes("Outcome: succeeded"),
			outcomeSummary: openPlacerRecord.outcome?.summary,
		}).toEqual({
			closed: "settled",
			placement: { kind: "remote_machine", machineId: joinerMachine.machineId },
			exit: "pin_machine_remote",
			remoteTask: true,
			deliveredOutcome: true,
			outcomeSummary: "Remote plan step read limits: MAX_RETRIES = 3.",
		});

		// ---- Leg 3b: Closed-Gate Fallback (Direct boundMachine Witness + Live Plan Fallback) ----
		const closedGateSpec: PlanNodeSpec = {
			id: "closed-gate-node",
			kind: "work",
			intent: "Read limits",
			inputs: [],
			after: [],
			writeScope: [],
			requirementIds: [],
			effort: "normal",
			since: 1,
		};
		const baseChoice = { placement: { kind: "local_worker" as const }, exit: "local_default" };
		expect(
			placementFor(closedGateSpec, baseChoice, {
				localRunnable: 1,
				candidates: [{ machineId: joinerMachine.machineId, slots: 2 }],
				remoteBackend: true,
				refused: new Set(),
				boundMachine: joinerMachine.machineId,
			}),
			"boundMachine stays remote while its gate is open",
		).toEqual({
			placement: { kind: "remote_machine", machineId: joinerMachine.machineId },
			exit: "bound_machine",
		});
		expect(
			placementFor(closedGateSpec, baseChoice, {
				localRunnable: 1,
				candidates: [],
				remoteBackend: true,
				refused: new Set(),
				boundMachine: joinerMachine.machineId,
			}),
			"boundMachine falls back to local base when its gate is closed",
		).toEqual(baseChoice);

		// Close Joiner's gate live on Joiner and let cap/1 propagate accepts.jobs=false to Hub.
		updateLinkPeerSettings(agentDirJoiner, hubIdentity.machineId, { acceptsJobs: false });
		await withDeadline(
			trace,
			"J10 leg 3b: closed gate cap/1 reaches hub",
			whenMachine(hub.jobs!, (m) => m.machineId === joinerMachine.machineId && m.facts?.accepts.jobs === false),
		);

		const fallbackPlanTitle = "Fallback locally when joiner gate is closed";
		const fallbackStarted = createBarrier();
		const fallbackDone = createBarrier();
		enqueueHubStepWorker(
			world,
			"fallback-survey",
			reportStep("j10-fallback-local-report", {
				status: "completed",
				summary: "Local fallback worker read limits: MAX_RETRIES = 3.",
			}),
		);
		enqueueHubRoot(
			world,
			...planCallSteps(
				"j10-plan-fallback",
				{
					action: "start",
					title: fallbackPlanTitle,
					steps: [
						{
							id: "fallback-survey",
							by: `machine:${joinerMachine.machineId}`,
							do: "Read src/limits.ts locally when joiner is closed. Change no file.",
						},
					],
				},
				"PLAN_STARTED",
				() => fallbackStarted.release(),
			),
			planUpdateStep("j10-plan-fallback-done", "PLAN_DONE", () => fallbackDone.release()),
		);
		world.systemOne.enterPhase("j10-leg3-fallback", PLAN_CALL_JUDGMENTS);
		await withDeadline(
			trace,
			"J10 leg 3b: start closed-gate plan",
			sessionHub.prompt("Survey limits with joiner closed."),
		);
		await withDeadline(trace, "J10 leg 3b: fallback plan started", fallbackStarted.promise);
		await withDeadline(trace, "J10 leg 3b: fallback plan finished", fallbackDone.promise);
		await withDeadline(trace, "J10 leg 3b: hub idle after fallback", sessionHub.waitForForegroundIdle());

		const fallbackPlan = planTitled(sessionHub, fallbackPlanTitle);
		expect({
			closed: fallbackPlan.closed?.status,
			placement: fallbackPlan.nodes["fallback-survey"]?.release?.placement,
			exit: fallbackPlan.nodes["fallback-survey"]?.release?.exit,
		}).toEqual({
			closed: "settled",
			placement: { kind: "local_worker" },
			exit: "pin_kept_local",
		});

		// Re-open Joiner's gate for Leg 3c.
		updateLinkPeerSettings(agentDirJoiner, hubIdentity.machineId, { acceptsJobs: true });
		await withDeadline(
			trace,
			"J10 leg 3b: reopened gate cap/1 reaches hub",
			whenMachine(
				hub.jobs!,
				(m) => m.machineId === joinerMachine.machineId && m.facts?.accepts.jobs === true && m.facts.room === 2,
			),
		);

		// ---- Leg 3c: Remote Plan Cancel Propagation over jobs/1 ----
		const cancelPlanTitle = "Cancel plan with running remote job on joiner";
		const cancelStarted = createBarrier();
		const cancelAccepted = createBarrier();
		const holdRemoteStep = createBarrier();
		const cancelMark = world.provider.reached.length;
		let cancelReceiptText = "";

		enqueueJoinerJob(
			world,
			"plan-cancel",
			reportStep(
				"j10-plan-cancel-hold",
				{ status: "completed", summary: "Never completed because cancelled." },
				holdRemoteStep.promise,
			),
		);
		enqueueHubRoot(
			world,
			...planCallSteps(
				"j10-plan-cancel-start",
				{
					action: "start",
					title: cancelPlanTitle,
					steps: [
						{
							id: "cancel-remote-step",
							by: `machine:${joinerMachine.machineId}`,
							do: "[j10-job:plan-cancel] Hold while inspecting docs/service.md. Change no file.",
						},
					],
				},
				"PLAN_STARTED",
				() => cancelStarted.release(),
			),
		);
		try {
			world.systemOne.enterPhase("j10-leg3-cancel-start", PLAN_CALL_JUDGMENTS);
			await withDeadline(
				trace,
				"J10 leg 3c: start remote cancel plan",
				sessionHub.prompt("Start the long inspection on joiner-box."),
			);
			await withDeadline(trace, "J10 leg 3c: cancel plan started", cancelStarted.promise);
			await withDeadline(
				trace,
				"J10 leg 3c: remote worker running on joiner",
				world.provider.whenReached(joinerJobReached("plan-cancel", "j10-plan-cancel-hold"), cancelMark),
			);
			expect(joinerHub.jobs!.runningHere(), "Joiner actively holds 1 running remote job").toBe(1);
			const runningPlan = planTitled(sessionHub, cancelPlanTitle);
			const remoteTaskId = runningPlan.nodes["cancel-remote-step"]?.release?.taskId;
			expect(remoteTaskId?.startsWith("remote-")).toBe(true);
			const remoteJobId = remoteTaskId?.replace(/^remote-/, "").replace(/:turn:\d+$/, "") ?? "";

			enqueueHubRoot(
				world,
				...planCallSteps(
					"j10-plan-cancel-stop",
					{ action: "cancel", reason: "Owner cancelled remote plan." },
					"PLAN_UPDATE",
					(text) => {
						cancelReceiptText = text;
						cancelAccepted.release();
					},
				),
			);
			world.systemOne.enterPhase("j10-leg3-cancel-stop", INTAKE_JUDGMENTS);
			await withDeadline(trace, "J10 leg 3c: cancel prompt", sessionHub.prompt("Stop the remote plan."));
			await withDeadline(trace, "J10 leg 3c: cancel receipt", cancelAccepted.promise);
			await withDeadline(trace, "J10 leg 3c: hub idle after cancel", sessionHub.waitForForegroundIdle());

			const cancelledExecutorRecord = await waitForExecutorJob(
				trace,
				"J10 leg 3c: job.cancel aborts Joiner worker and settles executor record",
				agentDirJoiner,
				(r) => r.jobId === remoteJobId && r.state === "terminal",
			);
			await withDeadline(
				trace,
				"J10 leg 3c: Joiner lane record reaches canceled",
				whenLaneRecords(sessionJoiner, (records) =>
					records.some((r) => r.laneId === cancelledExecutorRecord.laneId && r.status === "canceled"),
				),
			);

			const closedCancelPlan = planTitled(sessionHub, cancelPlanTitle);
			const cancelledAttempt = latestAttemptOf(sessionHub, remoteTaskId);
			expect({
				told: cancelReceiptText.includes("The plan is cancelled; its running steps are stopped."),
				closed: closedCancelPlan.closed && {
					status: closedCancelPlan.closed.status,
					reason: closedCancelPlan.closed.reason,
				},
				hubAttempt: cancelledAttempt && {
					status: cancelledAttempt.status,
					reasonCode: cancelledAttempt.result?.reasonCode,
				},
				joinerRunningAfter: joinerHub.jobs!.runningHere(),
				joinerExecutor: {
					state: cancelledExecutorRecord.state,
					cancel: cancelledExecutorRecord.cancel,
				},
				hubCalls: world.provider.reached.slice(cancelMark).filter((k) => k.startsWith(`${HUB_ROOT_TRACK}:`)),
			}).toEqual({
				told: true,
				closed: { status: "cancelled", reason: "Owner cancelled remote plan." },
				hubAttempt: { status: "cancelled", reasonCode: "plan_closed" },
				joinerRunningAfter: 0,
				joinerExecutor: { state: "terminal", cancel: "plan_closed" },
				hubCalls: [
					`${HUB_ROOT_TRACK}:j10-plan-cancel-start-call`,
					`${HUB_ROOT_TRACK}:j10-plan-cancel-start-result`,
					`${HUB_ROOT_TRACK}:j10-plan-cancel-stop-call`,
					`${HUB_ROOT_TRACK}:j10-plan-cancel-stop-result`,
				],
			});
		} finally {
			holdRemoteStep.release();
		}
		trace.mark("root", "j10.leg3-plan-placement-p28-and-cancel");

		// ---- Leg 4: ask Lane over RemoteHubController + Clean Teardown ----
		world.systemOne.enterPhase("j10-leg4-ask-and-offline", {});
		const askQuestion = "What retry ceiling is configured in this checkout?";
		const askAnswer = "Joiner status: retry ceiling is 3 attempts (250ms backoff).";
		const askWake = createBarrier();

		enqueueJoinerChannel(world, {
			name: "j10-joiner-ask-reply",
			check: (request) => {
				expect(request.context.systemPrompt).toContain(THIRD_PARTY_MEMORY_WITHHELD);
				expect(request.context.systemPrompt).not.toContain(JOINER_OWNER_SECRET_MEMORY);
				const delivered = JSON.stringify(request.context.messages);
				expect(delivered).toContain('source=\\"channel:link\\"');
				expect(delivered).toContain("not by the owner");
				expect(delivered).toContain(askQuestion);
			},
			reply: { content: [{ type: "text", text: askAnswer }] },
		});
		let askWakeRequest: Parameters<NonNullable<Parameters<typeof enqueueHubRoot>[1]["check"]>>[0] | undefined;
		enqueueHubRoot(world, {
			name: "j10-hub-ask-wake",
			check: (request) => {
				askWakeRequest = request;
				expect(currentRequestCarries(request, "succeeded")).toBe(true);
				askWake.release();
			},
			reply: { content: [{ type: "text", text: "Received joiner-box's answer." }] },
		});

		const askJobId = await hub.ask(JOINER_MACHINE_NAME, askQuestion);
		expect(askJobId.startsWith("ask")).toBe(true);
		await withDeadline(trace, "J10 leg 4: ask reply wakes hub", askWake.promise);
		await withDeadline(trace, "J10 leg 4: hub idle after ask", sessionHub.waitForForegroundIdle());
		await withDeadline(trace, "J10 leg 4: joiner idle after ask", sessionJoiner.agent.waitForIdle());
		expect(
			askWakeRequest && currentRequestCarries(askWakeRequest, askJobId),
			"Hub foreground wakes with compact handoff for the ask lane",
		).toBe(true);
		const settledAskRecord = await waitForPlacerJob(
			trace,
			"J10 leg 4: ask placer record applied",
			agentDirHub,
			(r) => r.jobId === askJobId && r.appliedAt !== undefined,
		);

		expect(settledAskRecord.outcome).toEqual({ status: "succeeded", summary: askAnswer });
		const chatMessages = hub.chat(JOINER_MACHINE_NAME);
		expect(
			chatMessages.map((msg) => ({
				role: msg.role,
				text: "content" in msg ? textBlocks(msg.content) : "",
			})),
		).toEqual([
			{ role: "user", text: askQuestion },
			{ role: "assistant", text: askAnswer },
		]);
		trace.mark("root", "j10.leg4-ask-replied");
	} finally {
		if (sessionJoiner) {
			await sessionJoiner.backgroundLanes.getRemoteHub().stop();
			expect(await world.disposeSessionInBody(sessionJoiner), "Joiner session disposes cleanly").toBeUndefined();
		}
		await hub.stop();
		expect(await world.disposeSessionInBody(sessionHub), "Hub session disposes cleanly").toBeUndefined();
	}

	expect(world.network?.open, "zero leaked virtual TCP sockets or servers after closing link").toBe(0);

	// Prove RemoteJobPorts.timers (world.timers.port("orchestration")) drives offline-hold expiry deterministically.
	await runTimedOfflineHoldWitness(world);

	expect(world.warnings.slice(warningsBefore), "zero unexpected warnings across Journey 10").toEqual([]);
}

/**
 * Journey 10: Linked Machines — mutual-auth `sealed/1` + `cap/1` + `jobs/1` over virtual TCP, one-time token replay
 * refusal, direct read-only job placement (isolated worker prompt + silent Joiner foreground), plan/fleet remote
 * placement + closed-gate local fallback + plan-scope remote cancel propagation, `RemoteHubController.ask`
 * round-trip (`THIRD_PARTY_MEMORY_WITHHELD`), and `TimerPort`-driven offline-hold expiry.
 */
export async function runJourney10(): Promise<void> {
	await runJourney(
		{
			name: "journey-10",
			journey: 10,
			virtualNetwork: true,
			files: {
				[projectPath("src", "limits.ts")]: LIMITS_CONTENT,
				[projectPath("docs", "service.md")]: SERVICE_DOC_CONTENT,
			},
			repository: {
				committed: {
					[LIMITS_REL_PATH]: LIMITS_CONTENT,
					[SERVICE_DOC_REL_PATH]: SERVICE_DOC_CONTENT,
				},
			},
		},
		runJourney10Body,
		JOURNEY_10_BUDGET_MS,
	);
}
