import "../builtin-install.ts";
import { join } from "node:path";
import { expect } from "vitest";
import { calls, createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, LIMITS_PATH, latestBatchResults } from "./shared.ts";

/** The intake judgments a plain prompt consumes here: a start without a profile asks no capability question. */
const { capabilities_authorized: _capabilities, ...INTAKE_JUDGMENTS } = ICM_INTAKE_JUDGMENTS;

/** The text the delegation gate's refusal opens with; the refused call's result carries it. */
const REFUSAL = "The root orchestrates and does not carry out task work itself";
const ORIGINAL_LIMITS = "export const MAX_RETRIES = 3;\n";

/** What a final answer is checked for once a work unit is open: nothing in these answers claims a delivery. */
const NO_DELIVERY_CLAIMS = {
	states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
	states_checks_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
	states_committed: { kind: "noul", probability: 0.02 },
	states_pushed: { kind: "noul", probability: 0.02 },
	states_published: { kind: "noul", probability: 0.02 },
	states_files_changed: { kind: "noul", probability: 0.02 },
} as const;

/** The effect questions the operation gate asks about a shell call it judges, answered "no effect". */
const OPERATION_JUDGMENTS = {
	leaves_machine: { kind: "noul", probability: 0.02 },
	cannot_be_undone: { kind: "noul", probability: 0.02 },
	touches_outside_task: { kind: "noul", probability: 0.02 },
	acquires_external_code: { kind: "noul", probability: 0.02 },
	request_authorizes: { kind: "noul", probability: 0.02 },
} as const;

/**
 * Orchestration enabled (`orchestrator.delegationGate`): the root orchestrates and its workers carry out the work.
 *
 * A typed write of a project file by the root is refused with the way to delegate it (both System One modes: the path decides);
 * the instruction file the worker will read is written into the agent directory and passes; the refused work is then done by a
 * delegated worker through the real shell and its handoff wakes the root. With System One on, a root shell call that System One
 * reads as task work is refused, and one it reads as inspection runs (the judgments are scripted per phase); with System One off
 * there is no engine and a shell call is never gated, so those two turns run only on.
 */
export async function runJourney4OrchestrationGatePhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const instructionsPath = join(world.agentDir, "instructions", "j4-limits.md");
	const instructions = "Set MAX_RETRIES to 5 in the limits file, then run the build.\n";

	// Turn 1: the root tries the edit itself, writes the instructions, delegates; the worker runs the build.
	world.shell.enqueue({
		name: "j4-worker-build",
		command: "echo j4-build",
		cwd: HARNESS_PROJECT_CWD,
		output: "j4-build\n",
		exitCode: 0,
	});
	const created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const session = created.session;
	const wake = createBarrier();
	world.provider.enqueue(
		"worker-a",
		{
			name: "j4-worker-build",
			check: (request) => {
				const offered = (request.context.tools ?? []).map((tool) => tool.name);
				if (!offered.includes("bash")) throw new Error(`the worker is not offered bash: ${offered.join(", ")}`);
				// The request shows the path through the model-visible alias legend, so the file name is the stable evidence.
				if (!JSON.stringify(request.context.messages).includes("j4-limits.md")) {
					throw new Error("the worker's instructions do not name the instruction file the root wrote");
				}
			},
			reply: {
				content: [{ type: "toolCall", id: "j4-build-1", name: "bash", arguments: { command: "echo j4-build" } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "j4-worker-report",
			check: (request) => {
				const build = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (build?.isError || !build?.text.includes("j4-build")) {
					throw new Error(`the worker's build did not run through the shell: ${build?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The build ran: j4-build." }] },
		},
	);
	world.provider.enqueue(
		"root",
		calls("j4-edit", [
			{
				id: "j4-edit-1",
				name: "edit",
				arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }] },
			},
		]),
		{
			name: "j4-edit-refused",
			check: (request) => {
				const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
				if (!edit?.isError || !edit.text.includes(REFUSAL)) {
					throw new Error(
						`the root's edit of a project file was not refused with the delegation directive: ${edit?.text ?? "no result"}`,
					);
				}
				expect(world.io.readFileSync(LIMITS_PATH, "utf8"), "the refused edit left the project file untouched").toBe(
					ORIGINAL_LIMITS,
				);
				world.faultMatrix.witness("OR1", { control: false });
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j4-write-1",
						name: "write",
						arguments: { path: instructionsPath, content: instructions },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j4-instructions-written",
			check: (request) => {
				const written = latestBatchResults(request).find((result) => result.toolName === "write");
				if (written?.isError) throw new Error(`the instruction file was refused: ${written.text}`);
				expect(
					world.io.readFileSync(instructionsPath, "utf8"),
					"an instruction file in the agent directory is orchestration, so the root's write of it passes",
				).toBe(instructions);
				world.faultMatrix.witness("OR1", { control: true });
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j4-start-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: "harness-script", modelId: "worker-a" },
							instructions: `Read ${instructionsPath} and follow it.`,
							readOnly: true,
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j4-started",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started")) {
					throw new Error(`the worker did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The change is delegated; the worker will report." }] },
		},
		{
			name: "j4-wake",
			maxRequests: 8,
			until: (request) => {
				const done = JSON.stringify(request.context.messages).includes("Background worker terminal handoff");
				if (done) wake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "The worker is still settling." }] },
		},
	);
	world.systemOne.enterPhase("j4-delegate", INTAKE_JUDGMENTS);
	await withDeadline(
		trace,
		"J4 turn 1",
		session.prompt("Change MAX_RETRIES in the limits file from 3 to 5 and run the build."),
	);
	await withDeadline(trace, "J4 the worker's handoff woke the root", wake.promise, 90_000);
	await withDeadline(trace, "J4 root idle", session.waitForForegroundIdle());
	expect(
		world.shell.requests.filter((request) => request.command === "echo j4-build").length,
		"the build ran exactly once, in the delegated worker",
	).toBe(1);
	world.faultMatrix.witness("OR3", { control: false });
	expect(
		world.io.readFileSync(LIMITS_PATH, "utf8"),
		"the root never edited the project file: its refused edit stayed refused and the read-only worker wrote none",
	).toBe(ORIGINAL_LIMITS);
	world.faultMatrix.witness("OR3", { control: true });
	trace.mark("root", "j4.delegated");

	if (world.systemOne.enabled) {
		// Turn 2: System One reads the root's shell call as task work: refused, and nothing reaches the shell.
		world.provider.enqueue(
			"root",
			calls("j4-shell-build", [{ id: "j4-shell-1", name: "bash", arguments: { command: "echo j4-root-build" } }]),
			{
				name: "j4-shell-refused",
				check: (request) => {
					const shell = latestBatchResults(request).find((result) => result.toolName === "bash");
					if (!shell?.isError || !shell.text.includes(REFUSAL)) {
						throw new Error(
							`the root's build was not refused with the delegation directive: ${shell?.text ?? "no result"}`,
						);
					}
					expect(
						world.shell.requests.filter((request) => request.command === "echo j4-root-build"),
						"the refused shell call never reached the shell",
					).toHaveLength(0);
					world.faultMatrix.witness("OR2", { control: false });
				},
				reply: { content: [{ type: "text", text: "I will delegate the build." }] },
			},
		);
		world.systemOne.enterPhase("j4-shell-refused", {
			...INTAKE_JUDGMENTS,
			...NO_DELIVERY_CLAIMS,
			performs_task_work: { kind: "noul", probability: 0.97 },
		});
		await withDeadline(trace, "J4 turn 2", session.prompt("Run the build yourself."));
		await withDeadline(trace, "J4 root idle after the refused build", session.waitForForegroundIdle());

		// Turn 3: the same tool for an inspection System One reads as no task work: it runs.
		world.shell.enqueue({
			name: "j4-root-inspect",
			command: "echo j4-inspect",
			cwd: HARNESS_PROJECT_CWD,
			output: "j4-inspect\n",
			exitCode: 0,
		});
		world.provider.enqueue(
			"root",
			calls("j4-shell-inspect", [{ id: "j4-inspect-1", name: "bash", arguments: { command: "echo j4-inspect" } }]),
			{
				name: "j4-inspected",
				check: (request) => {
					const shell = latestBatchResults(request).find((result) => result.toolName === "bash");
					if (shell?.isError || !shell?.text.includes("j4-inspect")) {
						throw new Error(`the root's inspection did not run: ${shell?.text ?? "no result"}`);
					}
					world.faultMatrix.witness("OR2", { control: true });
				},
				reply: { content: [{ type: "text", text: "The state is as expected." }] },
			},
		);
		world.systemOne.enterPhase("j4-shell-allowed", {
			...INTAKE_JUDGMENTS,
			...NO_DELIVERY_CLAIMS,
			...OPERATION_JUDGMENTS,
			performs_task_work: { kind: "noul", probability: 0.02 },
		});
		await withDeadline(trace, "J4 turn 3", session.prompt("Check the current state."));
		await withDeadline(trace, "J4 root idle after the inspection", session.waitForForegroundIdle());
	}

	expect(await world.disposeSessionInBody(session), "the J4 owner disposes cleanly").toBeUndefined();
	trace.mark("root", "j4.orchestration-gate");
}
