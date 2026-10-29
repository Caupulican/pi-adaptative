import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSessionEvent } from "../../../../src/core/agent-session.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import { AgentBusyError } from "../../../../src/kernel/agent.ts";
import { calls, createBarrier, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { assertBatchOk, lastToolResultDetails, requestTexts } from "./shared.ts";

/** Journey 2's live worker and owner-input boundary: advisory evaluation owns no root submission. */
export async function verifyEvaluationOccupancy(world: HarnessWorld): Promise<void> {
	const label = "h4-evaluation-occupancy";
	const created = await world.createRootSession("root", {
		agentDir: `${world.agentDir}-${label}`,
		sessionManager: world.createSessionManager(`${world.agentDir}-${label}`),
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	const session = created.session;
	const ownerJudgments = {
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
	} as const;
	const workerReached = createBarrier();
	const workerMayRead = createBarrier();
	const workerMayReport = createBarrier();
	const workerReporting = createBarrier();
	const supervisionReached = createBarrier();
	const supervisionMayAnswer = createBarrier();
	const supervisionSettled = createBarrier();
	const handoffReached = createBarrier();
	const summaryReached = createBarrier();
	const summaryMayAnswer = createBarrier();
	const compactionStarted = createBarrier();
	const queuedInputRegistered = createBarrier();
	const queuedReplyReached = createBarrier();
	const queuedInput = "Acknowledge the owner input queued during this inspection checkpoint.";
	const queuedReply = "The checkpoint input is acknowledged.";
	const warmInputs = [`${label} context alpha.`, `${label} context beta.`];
	const warmReplies = warmInputs.map((_, turn) =>
		Array.from(
			{ length: 80 },
			(_, index) =>
				`${label}-context-${turn}-${index}: Inspection context item ${index} concerns source value ${index + turn * 80}, its local name, and its enclosing module.`,
		).join("\n"),
	);
	const compactionEnds: Extract<AgentSessionEvent, { type: "compaction_end" }>[] = [];
	const compositionWork: Promise<unknown>[] = [];
	const failures: unknown[] = [];
	let handoffRequests = 0;
	const unsubscribeComposition = session.subscribe((event) => {
		if (event.type === "compaction_start" && event.reason === "manual") compactionStarted.release();
		if (event.type === "compaction_end" && event.reason === "manual") compactionEnds.push(event);
		if (event.type === "queue_update" && event.followUp.includes(queuedInput)) queuedInputRegistered.release();
	});
	let minimumAgeTimer: ReturnType<typeof setTimeout> | undefined;
	let agentId: string | undefined;
	const reads = world.systemOne.enabled ? 5 : 1;
	for (let index = 1; index <= reads; index++) {
		const path = projectPath("src", `${label}-${index}.ts`);
		world.io.writeFileSync(path, `export const inspectedValue${index} = ${index};\n`);
		world.provider.enqueue("worker-c", {
			...calls(`${label}-worker-read-${index}`, [
				{ id: `${label}-read-${index}`, name: "read", arguments: { path } },
			]),
			...(index === 1
				? {
						check: () => workerReached.release(),
						gate: workerMayRead.promise,
					}
				: {}),
		});
	}
	world.provider.enqueue("worker-c", {
		...calls(`${label}-worker-report`, [
			{
				id: `${label}-report`,
				name: "submit_report",
				arguments: { status: "completed", summary: "The source values were inspected." },
			},
		]),
		check: () => workerReporting.release(),
		gate: workerMayReport.promise,
	});
	world.provider.enqueue(
		"root",
		...warmReplies.map((reply, index) => ({
			...text(`${label}-warm-${index}`, reply),
			check: (request: Parameters<typeof requestTexts>[0]) =>
				expect(requestTexts(request).some((value) => value.includes(warmInputs[index]))).toBe(true),
		})),
		calls(`${label}-dispatch`, [
			{
				id: `${label}-start`,
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: HARNESS_PROVIDER, modelId: "worker-c" },
					instructions: "Inspect the named source values with read and report without changing files.",
					readOnly: true,
				},
			},
		]),
		{
			...text(`${label}-dispatched`, "The inspection agent is running."),
			check: (request) => {
				assertBatchOk(request, `${label}: delegation admitted`);
				const details = lastToolResultDetails(session, "delegate");
				if (isRecordObject(details) && typeof details.agentId === "string") agentId = details.agentId;
			},
		},
	);
	try {
		for (const [index, input] of warmInputs.entries()) {
			// Tool-free words are screened as backlog only when the next owner turn starts.
			world.systemOne.enterPhase(
				`${label}-warm-${index}`,
				index === 0 ? {} : { carries_0: { kind: "noul", probability: 0.02 }, ...ownerJudgments },
			);
			await withDeadline(world.trace, `${label}: actual warm turn ${index}`, session.prompt(input));
			await withDeadline(world.trace, `${label}: warm turn ${index} settles`, session.waitForForegroundIdle());
		}
		world.systemOne.enterPhase(`${label}-dispatch`, {
			carries_0: { kind: "noul", probability: 0.02 },
			...ownerJudgments,
			worker_task_fit: { kind: "choice", choice: "adequate", confidence: 0.97 },
		});
		await withDeadline(
			world.trace,
			`${label}: real delegate dispatch`,
			session.prompt("Start a read-only inspection agent."),
		);
		await withDeadline(world.trace, `${label}: worker provider boundary`, workerReached.promise);
		expect(agentId, `${label}: the production dispatch returned a worker identity`).toBeDefined();
		await withDeadline(world.trace, `${label}: root idle with worker held`, session.waitForForegroundIdle());
		if (world.systemOne.enabled) {
			world.systemOne.enterPhase(
				`${label}-supervision`,
				{
					meaningful_progress: { kind: "noul", probability: 0.97 },
					worker_stuck: { kind: "noul", probability: 0.02 },
					work_off_track: { kind: "noul", probability: 0.02 },
					strategy_repetition: { kind: "noul", probability: 0.02 },
					needs_independent_verification: { kind: "noul", probability: 0.02 },
					specialist_gap_present: { kind: "noul", probability: 0.02 },
					capability_gap_present: { kind: "noul", probability: 0.02 },
					external_block_present: { kind: "noul", probability: 0.02 },
				},
				{
					gate: supervisionMayAnswer.promise,
					expect: (request) => {
						expect(request.state, `${label}: supervision reads five executed production calls`).toMatchObject({
							toolCalls: 5,
						});
						expect(
							isRecordObject(request.state) &&
								typeof request.state.elapsedMs === "number" &&
								request.state.elapsedMs >= 3_000,
							`${label}: production supervision reaches its actual minimum evidence age`,
						).toBe(true);
					},
					onAdmit: () => supervisionReached.release(),
				},
			);
			// The supervisor's production evidence threshold is five calls and three elapsed seconds.
			// Age the already-started attempt at its transport gate; never alter the supervisor or poll it.
			minimumAgeTimer = setTimeout(() => workerMayRead.release(), 3_100);
			await withDeadline(world.trace, `${label}: actual supervision transport request`, supervisionReached.promise);
			await withDeadline(world.trace, `${label}: worker advances beside supervision`, workerReporting.promise);
			const health = session.getSemanticPlaneHealth();
			expect(health.state, `${label}: the held assessment is visible in whole-plane health`).toBe("evaluating");
			expect(health.inFlightEvaluations, `${label}: only advisory supervision is open`).toHaveLength(1);
			expect(health.inFlightEvaluations?.[0]?.occupancy).toBe("background");
			expect(session.isStreaming, `${label}: no root provider stream is active`).toBe(false);
			expect(
				session.getForegroundActivity().epoch,
				`${label}: no root submission owns the foreground`,
			).toBeUndefined();
		} else {
			// The same owner/worker overlap without a semantic plane must make no evaluation request.
			expect(session.getSemanticPlaneHealth().state).toBe("unbound");
		}

		const ownerInput = "Acknowledge this owner input while the inspection agent is still running.";
		const ownerReply = "Acknowledged.";
		world.systemOne.enterPhase(`${label}-owner-response`, {});
		world.provider.enqueue("root", {
			...text(`${label}-owner-response`, ownerReply),
			check: (request) => expect(requestTexts(request).some((value) => value.includes(ownerInput))).toBe(true),
		});
		await withDeadline(
			world.trace,
			`${label}: ordinary owner prompt before assessment release`,
			session.prompt(ownerInput),
		);
		await withDeadline(world.trace, `${label}: owner response fully settles`, session.waitForForegroundIdle());
		const persisted = created.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(
			persisted.some(
				(message) =>
					message.role === "user" &&
					(typeof message.content === "string"
						? message.content === ownerInput
						: message.content.some((block) => block.type === "text" && block.text === ownerInput)),
			),
		).toBe(true);
		expect(
			persisted.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "text" && block.text === ownerReply),
			),
		).toBe(true);

		// The exact same advisory assessment stays held while compaction owns the history and
		// newly registered owner input waits for that history's durable checkpoint.
		const assessment = session
			.getSemanticPlaneHealth()
			.inFlightEvaluations?.find((item) => item.occupancy === "background");
		const beforeCompact = created.sessionManager.getBranch();
		const earlierWarmReply = beforeCompact.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((block) => block.type === "text" && block.text === warmReplies[0]),
		);
		expect(earlierWarmReply, `${label}: earlier large context was actually admitted`).toBeDefined();
		const checkpointSummary = [
			"## Active Task",
			`User: ${ownerInput}`,
			"",
			"### Mandatory Rules",
			"(none)",
			"",
			"## Working Set",
			"(none)",
			"",
			"## Files",
			"(none)",
			"",
			"## Open Problems",
			"(none)",
			"",
			"## Done",
			"1. DELEGATE (unknown)",
			"",
			"## Key Decisions",
			"(none)",
			"",
			"## Constraints & Preferences",
			"(none)",
			"",
			"## Critical Context",
			"(none)",
			"",
			"## Context",
			`${label}-checkpoint: ${warmInputs[0]} ${warmInputs[1]}`,
			`Read-only inspection agent ${agentId} remains running; its report has not arrived.`,
		].join("\n");
		world.systemOne.enterPhase(`${label}-compaction`, {});
		world.provider.enqueue("root", {
			...text(`${label}-summary`, checkpointSummary),
			check: (request) => {
				expect(request.model.id, `${label}: actual default summarizer lane`).toBe("root");
				expect(
					requestTexts(request).some(
						(value) =>
							value.includes("Create a replacement checkpoint for the conversation above.") &&
							value.includes("verification demands:"),
					),
					`${label}: actual summary control request`,
				).toBe(true);
				expect(
					requestTexts(request).some((value) => value.includes(`${label}-context-0-79`)),
					`${label}: actual summary request covers earlier substantial context`,
				).toBe(true);
				summaryReached.release();
			},
			gate: summaryMayAnswer.promise,
		});
		const compaction = world.trace.track(session.compact("Retain the read-only inspection and owner context."));
		compositionWork.push(compaction);
		await withDeadline(world.trace, `${label}: manual compaction starts`, compactionStarted.promise);
		await withDeadline(world.trace, `${label}: actual summary provider held`, summaryReached.promise);
		const requestsWhileSummaryHeld = world.provider.requests.filter((request) => request.model.id === "root").length;
		world.systemOne.enterPhase(`${label}-queued-owner`, {
			...ownerJudgments,
			// The preceding tool-free ordinary owner turn is screened when this turn resumes.
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue("root", {
			...text(`${label}-queued-owner`, queuedReply),
			check: (request) => {
				expect(requestTexts(request).some((value) => value.includes(queuedInput))).toBe(true);
				expect(requestTexts(request).some((value) => value.includes(`${label}-checkpoint`))).toBe(true);
				queuedReplyReached.release();
			},
		});
		const queued = world.trace.track(session.prompt(queuedInput, { streamingBehavior: "followUp" }));
		compositionWork.push(queued);
		await withDeadline(world.trace, `${label}: owner input publicly registered`, queuedInputRegistered.promise);
		expect(session.getFollowUpMessages()).toEqual([queuedInput]);
		expect(world.provider.requests.filter((request) => request.model.id === "root")).toHaveLength(
			requestsWhileSummaryHeld,
		);
		expect(compactionEnds).toHaveLength(0);
		expect(created.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		summaryMayAnswer.release();
		const result = await withDeadline(world.trace, `${label}: checkpoint physically applied`, compaction);
		await withDeadline(world.trace, `${label}: queued owner admitted`, queued);
		await withDeadline(world.trace, `${label}: queued owner reaches provider`, queuedReplyReached.promise);
		await withDeadline(world.trace, `${label}: queued owner response settles`, session.waitForForegroundIdle());
		const afterCompact = created.sessionManager.getBranch();
		const checkpoint = afterCompact.find((entry) => entry.type === "compaction");
		// The kept second warm assistant splits its turn: production mechanically preserves
		// that turn's one earlier user message after the verified provider checkpoint.
		const expectedSummary = [
			checkpointSummary,
			"",
			"---",
			"",
			"**Turn Context (split turn):**",
			"",
			"## Original Request",
			warmInputs[1],
			"",
			"## Early Progress",
			"- 1 earlier message(s) compacted; durable facts are in the main checkpoint.",
			"",
			"## Context for Suffix",
			"- Retained messages continue the original request.",
		].join("\n");
		expect(result.summary).toBe(expectedSummary);
		expect(checkpoint?.type === "compaction" && checkpoint.summary).toBe(result.summary);
		expect(checkpoint?.type === "compaction" && checkpoint.firstKeptEntryId).toBe(result.firstKeptEntryId);
		expect(
			beforeCompact.findIndex((entry) => entry.id === result.firstKeptEntryId),
			`${label}: substantial earlier reply lies strictly before the checkpoint cut`,
		).toBeGreaterThan(beforeCompact.findIndex((entry) => entry.id === earlierWarmReply?.id));
		expect(compactionEnds).toHaveLength(1);
		expect(compactionEnds[0]).toMatchObject({ aborted: false, result: { summary: expectedSummary } });
		expect(afterCompact.filter((entry) => entry.type === "compaction_end")).toMatchObject([
			{ outcome: "success", compactionEntryId: checkpoint?.id },
		]);
		for (const words of [queuedInput, queuedReply]) {
			expect(
				afterCompact.filter(
					(entry) =>
						entry.type === "message" &&
						(entry.message.role === "user" || entry.message.role === "assistant") &&
						(typeof entry.message.content === "string"
							? entry.message.content === words
							: entry.message.content.some((block) => block.type === "text" && block.text === words)),
				),
				`${label}: queued words and actual answer persist exactly once`,
			).toHaveLength(1);
		}
		if (world.systemOne.enabled) {
			expect(assessment?.evaluationId).toBeDefined();
			expect(
				session.getSemanticPlaneHealth().inFlightEvaluations?.filter((item) => item.occupancy === "background"),
			).toEqual([assessment]);
		}
		expect(handoffRequests, `${label}: no worker terminal before report release`).toBe(0);
		if (world.systemOne.enabled) {
			expect(session.getSemanticPlaneHealth().state, `${label}: response arrived while assessment still held`).toBe(
				"evaluating",
			);
			const unsubscribe = session.onSemanticEvaluation((record) => {
				if (record.occupancy === "background") supervisionSettled.release();
			});
			try {
				supervisionMayAnswer.release();
				await withDeadline(world.trace, `${label}: supervision settlement event`, supervisionSettled.promise);
			} finally {
				unsubscribe();
			}

			// Safety control through real owner steering: its default foreground classification runs
			// without a submission lease, and must continue refusing an unqueued concurrent prompt.
			const foregroundReached = createBarrier();
			const foregroundMayAnswer = createBarrier();
			const steerText = "Acknowledge this next owner instruction.";
			world.systemOne.enterPhase(`${label}-foreground-control`, ownerJudgments, {
				gate: foregroundMayAnswer.promise,
				onAdmit: () => foregroundReached.release(),
			});
			const steering = session.steer(steerText);
			try {
				await withDeadline(world.trace, `${label}: foreground classification transport`, foregroundReached.promise);
				expect(session.getForegroundActivity().epoch).toBeUndefined();
				expect(
					session
						.getSemanticPlaneHealth()
						.inFlightEvaluations?.every((record) => record.occupancy === "foreground"),
				).toBe(true);
				const requestsBefore = world.provider.requests.filter((request) => request.model.id === "root").length;
				let refusal: unknown;
				try {
					await session.prompt("This unqueued input must not bypass foreground classification.");
				} catch (error) {
					refusal = error;
					world.trace.claimRejection(
						error,
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				expect(refusal, `${label}: default foreground evaluation refuses the normal prompt`).toBeInstanceOf(
					AgentBusyError,
				);
				expect(world.provider.requests.filter((request) => request.model.id === "root")).toHaveLength(
					requestsBefore,
				);
				world.systemOne.enterPhase(`${label}-foreground-delivered`, {});
				world.provider.enqueue("root", {
					...text(`${label}-foreground-delivered`, "Instruction acknowledged."),
					check: (request) => expect(requestTexts(request).some((value) => value.includes(steerText))).toBe(true),
				});
			} finally {
				foregroundMayAnswer.release();
			}
			await withDeadline(world.trace, `${label}: steering admitted`, steering);
			await withDeadline(world.trace, `${label}: steering response settles`, session.waitForForegroundIdle());
		} else {
			workerMayRead.release();
			await withDeadline(world.trace, `${label}: unjudged worker reaches report`, workerReporting.promise);
		}

		world.systemOne.enterPhase(`${label}-worker-terminal`, {});
		world.provider.enqueue("root", {
			...text(`${label}-worker-terminal`, "The inspection report arrived."),
			check: (request) => {
				expect(requestTexts(request).some((value) => value.includes("Background worker terminal handoff"))).toBe(
					true,
				);
				expect(requestTexts(request).some((value) => value.includes(agentId ?? "missing-worker"))).toBe(true);
				handoffRequests++;
				handoffReached.release();
			},
		});
		workerMayReport.release();
		await withDeadline(world.trace, `${label}: terminal reaches owning root`, handoffReached.promise);
		await withDeadline(world.trace, `${label}: terminal turn settles`, session.waitForForegroundIdle());
		if (agentId === undefined) throw new Error(`${label}: no admitted worker identity`);
		const worker = await withDeadline(
			world.trace,
			`${label}: worker releases resources`,
			session.backgroundLanes.waitForWorkerAgent(agentId, 60_000),
		);
		expect({ timedOut: worker.timedOut, status: worker.status }).toEqual({ timedOut: false, status: "idle" });
		expect(
			world.provider.requests
				.filter((request) => request.model.id === "root")
				.every(
					(request) =>
						!requestTexts(request).some((value) =>
							value.includes("This unqueued input must not bypass foreground classification."),
						),
				),
			`${label}: the refused foreground input never reaches a later request`,
		).toBe(true);
		if (!world.systemOne.enabled) expect(world.systemOne.requests).toEqual([]);
	} catch (error) {
		failures.push(error);
	} finally {
		if (minimumAgeTimer !== undefined) clearTimeout(minimumAgeTimer);
		workerMayRead.release();
		workerMayReport.release();
		supervisionMayAnswer.release();
		summaryMayAnswer.release();
		const joined = await Promise.allSettled(
			compositionWork.map((work, index) =>
				withDeadline(world.trace, `${label}: composition cleanup ${index}`, work),
			),
		);
		for (const result of joined) {
			if (result.status === "rejected" && !failures.includes(result.reason)) failures.push(result.reason);
		}
		try {
			expect(await world.disposeSessionInBody(session), `${label}: auxiliary root disposes cleanly`).toBeUndefined();
		} catch (error) {
			failures.push(error);
		} finally {
			unsubscribeComposition();
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, `${label}: interaction and cleanup failed`);
	expect(handoffRequests, `${label}: worker terminal reaches one parent provider through cleanup`).toBe(1);
	expect(
		created.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "background-worker-completion" &&
					JSON.stringify(entry.content).includes(agentId ?? "missing-worker"),
			),
		`${label}: one durable worker terminal survives cleanup`,
	).toHaveLength(1);
	world.trace.mark("root", label);
}
