import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createExecutionContext } from "@caupulican/pi-agent-core/paths";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { workerMachinePathRoots } from "../src/core/delegation/worker-machine-scope.ts";
import { setConcurrentResponses } from "./suite/concurrent-responses.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

it.each([
	{ path: undefined, pinned: false, goal: false },
	{ path: "child", pinned: false, goal: false },
	{ path: undefined, pinned: true, goal: false },
	{ path: undefined, pinned: false, goal: true },
])(
	"captures task cwd before queueing a worker (path=$path, pinned=$pinned, goal=$goal)",
	async ({ path, pinned, goal }) => {
		const harness = await createHarness({
			initialActiveToolNames: ["task_directory", "task_steps", "delegate", "goal", "read"],
			settings: {
				autonomy: { goalAutoContinue: false },
				modelCapability: { mode: "off" },
				workerDelegation: { enabled: true, orchestrationProfile: undefined },
			},
		});
		const project = join(harness.tempDir, "worker project 日本語");
		const expected = path ? join(project, path) : project;
		mkdirSync(join(project, "child"), { recursive: true });
		writeFileSync(join(expected, "marker.txt"), "SELECTED_WORKER_ONLY");
		writeFileSync(join(harness.tempDir, "marker.txt"), "AMBIENT_WORKER_ONLY");
		const terminal = Promise.withResolvers<void>();
		const off = harness.session.subscribe((event) => {
			if (event.type === "delegate_workers" && event.terminalSinceFlush.length > 0) terminal.resolve();
		});
		let workerOutput = "";
		const call = (name: string, args: Record<string, unknown>) =>
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
		const remaining = setConcurrentResponses(
			harness,
			[
				call("read", { path: "marker.txt" }),
				(context) => {
					workerOutput = context.messages
						.filter((message) => message.role === "toolResult")
						.map(getMessageText)
						.join("\n");
					return fauxAssistantMessage('{"summary":"Fixture read complete","status":"completed"}');
				},
			],
			[
				call("task_directory", { action: "register", workspaceId: "project", path: project }),
				call("task_directory", { action: "select", workspaceId: "project" }),
				...(pinned
					? [
							call("task_steps", {
								action: "set",
								steps: [{ content: "Pinned fixture", status: "in_progress" }],
							}),
							call("task_directory", { action: "bind", taskId: "step-1", workspaceId: "project", pinned: true }),
							call("task_directory", { action: "select", workspaceId: "session" }),
						]
					: []),
				...(goal
					? [
							call("goal", { action: "start", goalId: "fixture-goal", userGoal: "Read synthetic marker" }),
							call("goal", {
								action: "add_requirement",
								requirementId: "fixture-requirement",
								text: "Read synthetic marker",
							}),
							call("goal", {
								action: "dispatch_worker",
								requirementId: "fixture-requirement",
								instructions: "Read the synthetic marker.",
							}),
						]
					: [
							call("delegate", {
								action: "start",
								instructions: "Read the synthetic marker.",
								...(path ? { path } : {}),
							}),
						]),
				call("task_directory", { action: "select", workspaceId: "session" }),
				fauxAssistantMessage("Foreground project switched"),
				fauxAssistantMessage("Worker terminal acknowledged"),
			],
		);
		try {
			await harness.session.prompt("Dispatch in the selected project then switch the foreground.", {
				autoContinueGoal: false,
			});
			await terminal.promise;
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const worker = Object.values(snapshot.attempts)[0]?.dispatch.executionContract?.worker;
			expect(worker?.authority.cwd).toBe(expected);
			expect(worker?.authority.readPaths).toEqual(path ? [expected] : workerMachinePathRoots(harness.tempDir));
			expect(harness.session.getLaneRecords()).toEqual([expect.objectContaining({ status: "succeeded" })]);
			expect(workerOutput).toContain("SELECTED_WORKER_ONLY");
			expect(workerOutput).not.toContain("AMBIENT_WORKER_ONLY");
			expect(remaining()).toBe(0);
		} finally {
			off();
		}
	},
);

it.each(["foreign-session", "malformed"])("rejects %s host context before worker admission", async (kind) => {
	const harness = await createHarness({
		settings: { modelCapability: { mode: "off" }, workerDelegation: { enabled: true } },
	});
	const context = createExecutionContext({
		attachment: {
			workspaceId: "synthetic",
			attachmentId: "synthetic-attachment",
			root: harness.tempDir,
			flavor: process.platform === "win32" ? "win32" : "posix",
			caseSensitive: process.platform !== "win32",
		},
		cwd: harness.tempDir,
		sessionId: "another-session",
		generation: 0,
	});
	const result = await harness.session.runWorkerDelegationOnce({
		instructions: "Must not dispatch",
		executionContext: kind === "malformed" ? { ...context, generation: -1 } : context,
	});
	expect(result).toMatchObject({ started: false, skipReason: "worker_execution_context_invalid" });
	expect(harness.session.getLaneRecords()).toEqual([]);
});

it("keeps worker controls available when the foreground attachment has disappeared", async () => {
	const harness = await createHarness({
		initialActiveToolNames: ["task_directory", "delegate", "read"],
		settings: { modelCapability: { mode: "off" }, workerDelegation: { enabled: true } },
	});
	const project = join(harness.tempDir, "removed project");
	mkdirSync(project);
	harness.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("task_directory", { action: "register", workspaceId: "project", path: project })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "project" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Selected"),
	]);
	await harness.session.prompt("Select the synthetic directory.");
	renameSync(project, `${project}-moved`);
	const delegate = harness.session.getToolDefinition("delegate")!;
	const status = await delegate.execute("status", { action: "status" }, undefined, undefined, undefined as never);
	expect(status.isError).not.toBe(true);
	const start = await delegate.execute(
		"start",
		{ action: "start", instructions: "Must not silently use the launch directory." },
		undefined,
		undefined,
		undefined as never,
	);
	expect(start.isError).toBe(true);
	expect(harness.session.getLaneRecords()).toEqual([]);
});

it.each([undefined, "child"])("does not execute queued work in a replacement directory (path=%s)", async (path) => {
	const harness = await createHarness({
		initialActiveToolNames: ["task_directory", "delegate", "read"],
		settings: { modelCapability: { mode: "off" }, workerDelegation: { enabled: true } },
	});
	const project = join(harness.tempDir, "replaceable project");
	const target = path ? join(project, path) : project;
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "marker.txt"), "ORIGINAL_DIRECTORY");
	const terminal = Promise.withResolvers<void>();
	const off = harness.session.subscribe((event) => {
		if (event.type === "delegate_workers" && event.terminalSinceFlush.length) terminal.resolve();
	});
	const call = (name: string, args: Record<string, unknown>) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	const remainingWorkers = setConcurrentResponses(
		harness,
		[
			call("read", { path: "marker.txt" }),
			fauxAssistantMessage('{"summary":"Fixture completed","status":"completed"}'),
		],
		[
			call("task_directory", { action: "register", workspaceId: "project", path: project }),
			call("task_directory", { action: "select", workspaceId: "project" }),
			call("delegate", { instructions: "Read the synthetic marker.", ...(path ? { path } : {}) }),
			() => {
				renameSync(target, `${target}-previous`);
				mkdirSync(target);
				writeFileSync(join(target, "marker.txt"), "REPLACEMENT_MUST_NOT_EXECUTE");
				return fauxAssistantMessage("Fixture directory replaced before queue dispatch");
			},
			fauxAssistantMessage("Terminal acknowledged"),
		],
	);
	try {
		await harness.session.prompt("Queue the synthetic worker.", { autoContinueGoal: false });
		await terminal.promise;
		const records = harness.session.getLaneRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.status).not.toBe("succeeded");
		expect(records[0]?.reasonCode).toContain("directory");
		expect(remainingWorkers()).toBe(2);
	} finally {
		off();
	}
});
