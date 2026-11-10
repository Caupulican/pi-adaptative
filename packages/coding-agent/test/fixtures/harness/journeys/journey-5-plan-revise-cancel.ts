import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	enqueueRoot,
	enqueueStepWorker,
	INTAKE_JUDGMENTS,
	latestAttemptOf,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	ROOT_TRACK,
	reportStep,
	stepReached,
} from "./journey-5-shared.ts";

const TITLE = "Read three settings and list them";
const READERS = ["read-first", "read-second", "read-third"] as const;

/**
 * Revise and cancel while steps run. Three steps are in flight when the owner drops one: the root revises the plan, the
 * removed step's worker is stopped with the plan's reason for a removed step, and the two others keep their workers. Then the
 * owner stops the plan: the root cancels it, the running workers are stopped with the plan's reason for a closed plan, and no
 * result is ever sent.
 */
export async function runJourney5PlanReviseCancelPhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const started = createBarrier();
	const revised = createBarrier();
	const cancelled = createBarrier();
	// Never released: every reader is still waiting on its model when the plan drops or stops it.
	const hold = createBarrier();
	let cancelText = "";
	const mark = world.provider.reached.length;
	for (const nodeId of READERS) {
		enqueueStepWorker(
			world,
			nodeId,
			reportStep(
				`j5-revise-${nodeId}`,
				{ status: "completed", summary: `${nodeId} found a setting.` },
				hold.promise,
			),
		);
	}
	const taskIds = () => {
		const plan = planTitled(session, TITLE);
		return READERS.map((nodeId) => plan.nodes[nodeId]?.release?.taskId);
	};
	const ends = (ids: readonly (string | undefined)[]) =>
		ids.map((taskId) => {
			const attempt = latestAttemptOf(session, taskId);
			return attempt && { status: attempt.status, reasonCode: attempt.result?.reasonCode };
		});
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-revise",
			{
				action: "start",
				title: TITLE,
				steps: [
					...READERS.map((id) => ({
						id,
						do: `Read src/limits.ts and report one setting it holds, as ${id}. Change no file.`,
					})),
					{ id: "listing", do: "List the settings found.", join: "collect", uses: [...READERS] },
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
	);
	world.systemOne.enterPhase("j5-revise-start", PLAN_CALL_JUDGMENTS);
	await withDeadline(trace, "J5 revise: the start turn", session.prompt("Read three settings and list them."));
	await withDeadline(trace, "J5 revise: the plan started", started.promise);
	await withDeadline(
		trace,
		"J5 revise: three steps in flight",
		Promise.all(
			READERS.map((nodeId) => world.provider.whenReached(stepReached(nodeId, `j5-revise-${nodeId}`), mark)),
		),
	);
	const released = taskIds();

	// The owner drops the third reading: the root removes the step and restates the join over the two that stay.
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-revise-drop",
			{
				action: "revise",
				reason: "The owner dropped the third reading.",
				remove: ["read-third"],
				steps: [
					{ id: "listing", do: "List the settings found.", join: "collect", uses: ["read-first", "read-second"] },
				],
			},
			"PLAN_UPDATE",
			() => revised.release(),
		),
	);
	world.systemOne.enterPhase("j5-revise-drop", {
		...INTAKE_JUDGMENTS,
		misses_request_part: { kind: "noul", probability: 0.02 },
	});
	await withDeadline(trace, "J5 revise: the drop turn", session.prompt("Drop the third reading; two are enough."));
	await withDeadline(trace, "J5 revise: the plan was revised", revised.promise);
	await withDeadline(trace, "J5 revise: root idle after the revise", session.waitForForegroundIdle());
	const afterRevise = planTitled(session, TITLE);
	expect(
		{
			version: "title" in afterRevise.record ? afterRevise.record.version : undefined,
			steps: "title" in afterRevise.record ? afterRevise.record.nodes.map((node) => node.id) : undefined,
			retired: afterRevise.retired.map((entry) => [entry.nodeId, entry.taskId === released[2], entry.reason]),
			keptWorkers: taskIds()
				.slice(0, 2)
				.map((taskId, index) => taskId === released[index]),
			ends: ends(released),
			closed: afterRevise.closed?.status,
		},
		"the removed step's worker was stopped for the removal, and the two steps that stayed kept their running workers",
	).toEqual({
		version: 2,
		steps: ["read-first", "read-second", "listing"],
		retired: [["read-third", true, "removed"]],
		keptWorkers: [true, true],
		ends: [
			{ status: "running", reasonCode: undefined },
			{ status: "running", reasonCode: undefined },
			{ status: "cancelled", reasonCode: "plan_step_removed" },
		],
		closed: undefined,
	});

	// The owner stops the plan: the root cancels it and every running step ends.
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-revise-stop",
			{ action: "cancel", reason: "The owner stopped the plan." },
			"PLAN_UPDATE",
			(text) => {
				cancelText = text;
				cancelled.release();
			},
		),
	);
	world.systemOne.enterPhase("j5-revise-stop", INTAKE_JUDGMENTS);
	await withDeadline(trace, "J5 revise: the stop turn", session.prompt("Stop the plan."));
	await withDeadline(trace, "J5 revise: the plan was cancelled", cancelled.promise);
	await withDeadline(trace, "J5 revise: root idle after the cancel", session.waitForForegroundIdle());
	const afterCancel = planTitled(session, TITLE);
	expect(
		{
			told: cancelText.includes("The plan is cancelled; its running steps are stopped."),
			closed: afterCancel.closed && { status: afterCancel.closed.status, reason: afterCancel.closed.reason },
			listed: afterCancel.nodes.listing?.join !== undefined,
			ends: ends(released),
		},
		"the cancelled plan closed with the owner's reason, never combined a result, and its running workers were stopped for the close",
	).toEqual({
		told: true,
		closed: { status: "cancelled", reason: "The owner stopped the plan." },
		listed: false,
		ends: [
			{ status: "cancelled", reasonCode: "plan_closed" },
			{ status: "cancelled", reasonCode: "plan_closed" },
			{ status: "cancelled", reasonCode: "plan_step_removed" },
		],
	});
	expect(
		world.provider.reached.slice(mark).filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
		"the root made its three calls and was woken by nothing: a stopped step and a cancelled plan send no result",
	).toEqual([
		`${ROOT_TRACK}:j5-revise-call`,
		`${ROOT_TRACK}:j5-revise-result`,
		`${ROOT_TRACK}:j5-revise-drop-call`,
		`${ROOT_TRACK}:j5-revise-drop-result`,
		`${ROOT_TRACK}:j5-revise-stop-call`,
		`${ROOT_TRACK}:j5-revise-stop-result`,
	]);
	hold.release();
	trace.mark("root", "j5.plan-revise-cancel");
}
