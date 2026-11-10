import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	deliveredLines,
	enqueueRoot,
	enqueueStepWorker,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	ROOT_TRACK,
	reportStep,
	stepTaskLines,
	stepTrack,
} from "./journey-5-shared.ts";
import { latestBatchResults } from "./shared.ts";

const TITLE = "Find where the retry limit is read, then rename it everywhere";
const OPEN_ITEM = "Two generated files also read the limit and were not opened.";
const HOLD = `step find-readers's result changes what this step must do: ${OPEN_ITEM}`;

/**
 * A result that changes the next step's work. A step reports what it found and one item it left open; the step after it
 * uses that result. With System One on, the host reads the result against the dependent step before releasing it: the open
 * item changes what the dependent must do, so the dependent is held for re-planning with that item, and the root is told
 * once. The root restates the dependent, the restated step is read again, and it runs. With System One off nothing reads the
 * result and the dependent runs as written. Either way the dependent's task carries the open item.
 */
export async function runJourney5PlanResultGatePhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const judged = world.systemOne.enabled;
	const started = createBarrier();
	const done = createBarrier();
	let replanUpdate: string[] = [];
	let heldBefore: unknown;
	let dependentTask: string[] = [];
	const mark = world.provider.reached.length;
	enqueueStepWorker(
		world,
		"find-readers",
		reportStep("j5-gate-find-report", {
			status: "completed",
			summary: "src/limits.ts exports the limit and one module reads it.",
			remaining: [OPEN_ITEM],
		}),
	);
	enqueueStepWorker(world, "rename-limit", {
		...reportStep("j5-gate-rename-report", {
			status: "completed",
			summary: "The rename is listed for every reader, the two generated files included.",
		}),
		check: (request) => {
			dependentTask = stepTaskLines(request);
		},
	});
	const held = () => {
		const node = planTitled(session, TITLE).nodes["rename-limit"];
		return { held: node?.held && { reason: node.held.reason, detail: node.held.detail }, released: !!node?.release };
	};
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-gate",
			{
				action: "start",
				title: TITLE,
				steps: [
					{
						id: "find-readers",
						do: "Find every file that reads MAX_RETRIES and report the list, and anything you could not check. Change no file.",
					},
					{
						id: "rename-limit",
						do: "List the rename of MAX_RETRIES to RETRY_LIMIT for each file the earlier step found. Change no file.",
						uses: ["find-readers"],
					},
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		...(judged
			? [
					// The held step wakes the root once; it restates the step so the open item is part of its task.
					{
						...planUpdateStep("j5-gate-replan", "REPLAN", (request) => {
							replanUpdate = deliveredLines(request);
							heldBefore = held();
							// The restated step is read again: it now covers the open item, so the result no longer changes it.
							world.systemOne.enterPhase("j5-gate-restated", {
								misses_request_part: { kind: "noul", probability: 0.02 },
								brief_self_contained: { kind: "noul", probability: 0.97 },
								changes_dependent_work: { kind: "noul", probability: 0.02 },
								result_evidence_sufficient: { kind: "noul", probability: 0.97 },
							});
						}),
						reply: {
							content: [
								{
									type: "toolCall" as const,
									id: "j5-gate-revise-1",
									name: "plan",
									arguments: {
										action: "revise",
										reason: "The earlier step left two generated files unopened; the rename covers them too.",
										steps: [
											{
												id: "rename-limit",
												do: "List the rename of MAX_RETRIES to RETRY_LIMIT for each file the earlier step found, and for the two generated files it did not open. Change no file.",
												uses: ["find-readers"],
											},
										],
									},
								},
							],
							stopReason: "toolUse" as const,
						},
					},
					{
						name: "j5-gate-revised",
						check: (request: Parameters<typeof latestBatchResults>[0]) => {
							const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
							if (result?.isError || !result?.text.includes("PLAN_UPDATE")) {
								throw new Error(`the revise was not accepted: ${result?.text ?? "no result"}`);
							}
						},
						reply: { content: [{ type: "text" as const, text: "The rename now covers the generated files." }] },
					},
				]
			: []),
		planUpdateStep("j5-gate-wake", "PLAN_DONE", () => done.release()),
	);
	world.systemOne.enterPhase("j5-gate", {
		...PLAN_CALL_JUDGMENTS,
		// The first step's result names something its dependent does not cover, and says so plainly.
		changes_dependent_work: { kind: "noul", probability: 0.97 },
		result_evidence_sufficient: { kind: "noul", probability: 0.97 },
	});
	await withDeadline(
		trace,
		"J5 gate turn",
		session.prompt("Find where the retry limit is read, then list its rename everywhere."),
	);
	await withDeadline(trace, "J5 gate: the plan started", started.promise);
	await withDeadline(trace, "J5 gate: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 gate: root idle", session.waitForForegroundIdle());
	const plan = planTitled(session, TITLE);
	expect(
		{
			heldBefore,
			replan: replanUpdate.filter(
				(line) => line.includes("h PLAN_UPDATE,") || line.startsWith("step find-readers's result"),
			),
			version: "title" in plan.record ? plan.record.version : undefined,
			held: held(),
			openItem: dependentTask.filter((line) => line.startsWith("Open items from step ")),
			closed: plan.closed?.status,
		},
		"with System One on the dependent was held on the open item until the root restated it; its task carries the open item either way",
	).toEqual({
		heldBefore: judged ? { held: { reason: "replan", detail: HOLD }, released: false } : undefined,
		replan: judged ? ["h PLAN_UPDATE,REPLAN,READ_ALL", HOLD] : [],
		version: judged ? 2 : 1,
		held: { held: undefined, released: true },
		openItem: [`Open items from step find-readers: ${OPEN_ITEM}.`],
		closed: "settled",
	});
	const reached = world.provider.reached.slice(mark);
	expect(
		{
			root: reached.filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
			workers: ["find-readers", "rename-limit"].map(
				(nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)).length,
			),
		},
		"each step ran once; the root was woken for the held step only when System One read the result",
	).toEqual({
		root: [
			`${ROOT_TRACK}:j5-gate-call`,
			`${ROOT_TRACK}:j5-gate-result`,
			...(judged ? [`${ROOT_TRACK}:j5-gate-replan`, `${ROOT_TRACK}:j5-gate-revised`] : []),
			`${ROOT_TRACK}:j5-gate-wake`,
		],
		workers: [1, 1],
	});
	trace.mark("root", "j5.plan-result-gate");
}
