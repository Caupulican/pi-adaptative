/** A scheduled bot places a read-only job through a real paired link; both operator views read the same durable result. */
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { taskStatus } from "../../../../src/core/channels/owner-task.ts";
import { PersistentBotTeamStore } from "../../../../src/core/delegation/persistent-bot-team-store.ts";
import type { RemoteHubController } from "../../../../src/core/remote/hub-controller.ts";
import { JobStore } from "../../../../src/core/remote/job-store.ts";
import { routineJobScope } from "../../../../src/core/remote/routine-job-origin.ts";
import { readRoutineBotJobResults, routineJobStatusLines } from "../../../../src/core/remote/routine-job-results.ts";
import { routineAwayReadiness } from "../../../../src/core/routines/routine-away-readiness.ts";
import { formatRoutineList } from "../../../../src/modes/interactive/bot-team-lines.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { createOwnerBot, enqueueBot } from "./journey-7-shared.ts";
import {
	enqueueHubRoot,
	enqueueJoinerJob,
	joinerJobReached,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planUpdateStep,
	reportStep,
	whenMachine,
} from "./journey-10-shared.ts";
import { currentRequestCarries } from "./shared.ts";

export async function scheduledBotJob(
	world: HarnessWorld,
	root: AgentSession,
	hub: RemoteHubController,
	port: number,
	machine: string,
): Promise<void> {
	const name = "schedule-inspector";
	const soul = "You inspect retry limits on the paired machine.";
	const summary = "The paired checkout allows exactly three retries.";
	const prompt = "Use a plan to check the retry limit on the paired machine.";
	const store = root.backgroundLanes.getBotTeamStore();
	const agentDir = store.getAgentDir();
	createOwnerBot(root, name, "worker-c", soul);
	const started = createBarrier();
	const release = createBarrier();
	const done = createBarrier();
	const plan = planCallSteps(
		"j10-scheduled-place",
		{
			action: "start",
			title: "Read the paired checkout",
			steps: [
				{
					id: "inspect",
					by: `machine:${machine}`,
					do: "[j10-job:scheduled] Read the retry limit in src/limits.ts. Change no file.",
				},
			],
		},
		"PLAN_STARTED",
		() => {},
	);
	enqueueBot(
		world,
		"j10-scheduled-bot",
		"worker-c",
		soul,
		...plan,
		planUpdateStep("j10-scheduled-finished", "PLAN_DONE", done.release),
	);
	enqueueJoinerJob(
		world,
		"scheduled",
		reportStep("j10-scheduled-report", { status: "completed", summary }, release.promise, started.release),
	);
	// The scheduled message supplies a plan brief without going through owner request intake.
	const { misses_request_part, brief_self_contained } = PLAN_CALL_JUDGMENTS;
	world.systemOne.enterPhase("j10-scheduled-placement", { misses_request_part, brief_self_contained });

	const add = (routineId: string, at: number) =>
		store.upsertRoutine({
			createOnly: true,
			routineId,
			target: { kind: "bot", agentId: name },
			prompt,
			schedule: { kind: "once", at },
		});
	const now = world.timers.port("routines").now();
	const sibling = add("later-limit-check", now + 86_400_000);
	const routine = add("paired-limit-check", now + 1_000);
	const awayFacts = { daemon: "running" as const, autostart: "off" as const, enabled: true, ciEvents: true, now };
	expect(routineAwayReadiness(routine, awayFacts)).toMatchObject({
		state: "waiting",
		reason: expect.stringContaining("saved project"),
	});
	const botRecord = store.getBot(name)!;
	const pinned = { ...routine, ...root.backgroundLanes.captureBotScheduleOrigin() };
	expect(routineAwayReadiness(pinned, { ...awayFacts, bot: botRecord }).state).toBe("eligible");
	expect(routineAwayReadiness(pinned, { ...awayFacts, bot: { ...botRecord, profileId: "reviewer" } })).toMatchObject({
		state: "waiting",
		reason: expect.stringContaining("reviewer"),
	});
	const rootWake = createBarrier();
	enqueueHubRoot(world, {
		name: "j10-scheduled-routine-receipt",
		check: (request) => {
			expect(currentRequestCarries(request, `Routine ${routine.routineId} ended: succeeded.`)).toBe(true);
			rootWake.release();
		},
		reply: { content: [{ type: "text", text: "The bot received its scheduled task." }] },
	});
	world.timers.advance("routines", 1_000);
	try {
		const ticking = root.tickPersistentRoutines();
		await withDeadline(world.trace, "scheduled bot's remote worker began", started.promise);
		const offline = whenMachine(hub.jobs!, (peer) => peer.machineId === machine && !peer.online);
		await hub.stopListening();
		await withDeadline(world.trace, "scheduled placement sees disconnected machine", offline);
		await hub.listen("127.0.0.1", port);
		await withDeadline(
			world.trace,
			"scheduled placement resumes on the same paired machine",
			whenMachine(hub.jobs!, (peer) => peer.machineId === machine && peer.online),
		);
		release.release();
		await withDeadline(world.trace, "scheduled placement settled on bot's own plan", done.promise);
		await withDeadline(world.trace, "scheduled tick settled", ticking);
		await withDeadline(world.trace, "scheduled routine receipt reached the root", rootWake.promise);
		await withDeadline(world.trace, "root idle after scheduled routine receipt", root.waitForForegroundIdle());
		const fresh = new PersistentBotTeamStore(agentDir);
		try {
			const saved = fresh.getRoutine(routine.routineId)!;
			const occurrences = fresh.listRoutineOccurrences({ routineId: routine.routineId });
			expect(occurrences).toHaveLength(1);
			expect(occurrences[0]?.trigger.kind).toBe("schedule");
			const placer = new JobStore(agentDir).out
				.list()
				.find((job) => job.offer.instructions.includes("[j10-job:scheduled]"));
			expect(placer?.routineScope, "placed record carries the scheduled input's scope").toBe(
				routineJobScope(name, occurrences[0]!.occurrenceId),
			);
			const jobs = readRoutineBotJobResults(agentDir, occurrences[0]!);
			expect(jobs).toHaveLength(1);
			expect(jobs[0]).toMatchObject({ summary });
			expect(placer?.jobId).toBe(jobs[0]?.jobId);
			expect(placer?.ownerSession).toBeDefined();
			expect(placer?.ownerSession).not.toBe(root.sessionId);
			expect(placer?.executorId).toBe(machine);
			expect(
				world.provider.reached.filter((step) => step === joinerJobReached("scheduled", "j10-scheduled-report")),
			).toHaveLength(1);
			const reads = world.provider.reached.length;
			const phone = (id: string, incarnation: string) =>
				taskStatus(
					{
						getBotTeamStore: () => fresh,
						routineAwayReader: root.backgroundLanes.routineAwayReader,
					},
					{ bot: name, routine: id, incarnation },
				);
			expect(phone(saved.routineId, saved.incarnationId)).toContain(jobs[0]!.jobId);
			expect(phone(saved.routineId, saved.incarnationId)).toContain(summary);
			expect(formatRoutineList([saved], undefined, (entry) => routineJobStatusLines(fresh, entry))).toContain(
				summary,
			);
			expect(phone(sibling.routineId, sibling.incarnationId)).not.toContain(summary);
			expect(phone(saved.routineId, sibling.incarnationId)).not.toContain(summary);
			expect(world.provider.reached).toHaveLength(reads);
		} finally {
			fresh.dispose();
		}
	} finally {
		release.release();
	}
}
