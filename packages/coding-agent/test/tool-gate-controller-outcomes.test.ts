import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentContext, BeforeToolCallResult } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityEnvelope, GateOutcome } from "../src/core/autonomy/contracts.ts";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import type { ToolCallEvent, ToolCallEventResult } from "../src/core/extensions/types.ts";
import { SystemOneController } from "../src/core/system-one/controller.ts";
import { ExecutionStore } from "../src/core/system-one/execution-state.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import { ToolSelectionController } from "../src/core/tool-selection/tool-selection-controller.ts";
import { tempDir } from "./temp-dir.ts";

/**
 * The envelope is evaluated before and after extension hooks (a hook may rewrite the arguments in
 * place), but exactly ONE gate outcome is published per tool call: the pre-hook denial when it
 * rejects, otherwise the final post-hook outcome. A later cancellation keeps the last completed
 * decision on record; a call cancelled before any evaluation completes publishes nothing.
 */
type Hook = (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;

function fakeRunner(hooks: Hook[]): ExtensionRunner {
	return {
		hasHandlers: (type: string) => type === "tool_call" && hooks.length > 0,
		emitToolCall: async (event: ToolCallEvent) => {
			let result: ToolCallEventResult | undefined;
			for (const hook of hooks) result = (await hook(event)) ?? result;
			return result;
		},
	} as unknown as ExtensionRunner;
}

function createController(options: {
	cwd: string;
	envelope: CapabilityEnvelope | undefined;
	hooks?: Hook[];
	checkEdge?: () => Promise<BeforeToolCallResult | undefined>;
}) {
	const outcomes: GateOutcome[] = [];
	const controller = new ToolGateController({
		maybeEscalateToolCall: () => undefined,
		getCwd: () => options.cwd,
		getCapabilityEnvelope: () => options.envelope,
		recordGateOutcome: (outcome) => outcomes.push(outcome),
		getExtensionRunner: () => fakeRunner(options.hooks ?? []),
		...(options.checkEdge ? { checkEdge: options.checkEdge } : {}),
	});
	const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
		controller.beforeToolCall(
			{
				assistantMessage: fauxAssistantMessage(""),
				toolCall: { id: `call-${outcomes.length + 1}`, name: "read", arguments: args },
				args,
			} as Parameters<typeof controller.beforeToolCall>[0],
			signal,
		);
	return { call, outcomes };
}

function createSystemOneController(runId: string): SystemOneController {
	return new SystemOneController({
		store: new ExecutionStore({
			run_id: runId,
			objective: { request: "test", normalized_goal: "test", acceptance_criteria: [] },
			repo: { root: "/fixture", baseline_revision: "base" },
		}),
		adapter: { evaluate: async () => ({ model: "fixture", answers: {}, latency_ms: 0 }) },
	});
}

function createGate(
	cwd: string,
	systemOne?: SystemOneController,
	selection?: ToolSelectionController,
): ToolGateController {
	return new ToolGateController({
		maybeEscalateToolCall: () => undefined,
		getCwd: () => cwd,
		getCapabilityEnvelope: () => undefined,
		recordGateOutcome: () => {},
		getExtensionRunner: () => fakeRunner([]),
		getSystemOneController: () => systemOne,
		getToolSelectionController: () => selection,
	});
}

function invocation(providerCallId: string, name: string, args: Record<string, unknown>) {
	const assistantMessage = fauxAssistantMessage("");
	const toolCall = fauxToolCall(name, args, { id: providerCallId });
	const context: AgentContext = { systemPrompt: "test", messages: [], tools: [] };
	return { assistantMessage, toolCall, args, context };
}

function payloadHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function admit(gate: ToolGateController, call: ReturnType<typeof invocation>): Promise<void> {
	const result = await gate.beforeToolCall(call, undefined);
	expect(result).toBeUndefined();
}

async function finish(
	gate: ToolGateController,
	call: ReturnType<typeof invocation>,
	text: string,
	isError: boolean,
): Promise<void> {
	await gate.afterToolCall({
		assistantMessage: call.assistantMessage,
		toolCall: call.toolCall,
		args: call.args,
		context: call.context,
		result: { content: [{ type: "text", text }], details: {} },
		isError,
	});
}

describe("ToolGateController publishes one gate outcome per tool call", () => {
	function scope(): { cwd: string; outside: string } {
		return { cwd: tempDir("pi-gate-outcomes-"), outside: tempDir("pi-gate-outside-") };
	}

	it("names the edge classes of an admitted call so the session can project DELIVER", async () => {
		const { cwd } = scope();
		const noted: { id: string; classes: readonly string[] }[] = [];
		const controller = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => cwd,
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => {},
			getExtensionRunner: () => fakeRunner([]),
			noteEdgeOperations: (id, classes) => noted.push({ id, classes }),
		});
		const call = (name: string, args: Record<string, unknown>) =>
			controller.beforeToolCall(
				{
					assistantMessage: fauxAssistantMessage(""),
					toolCall: { id: `call-${noted.length + 1}`, name, arguments: args },
					args,
				} as Parameters<typeof controller.beforeToolCall>[0],
				undefined,
			);
		expect(await call("bash", { command: "rm -rf ." })).toBeUndefined();
		expect(await call("bash", { command: "npm publish" })).toBeUndefined();
		expect(noted).toEqual([
			{ id: "call-1", classes: ["destructive.fs"] },
			{ id: "call-2", classes: [] },
		]);
	});

	it("blocks an optional extension before its hooks when the current request does not name it", async () => {
		const { cwd } = scope();
		let hookCalls = 0;
		const controller = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => cwd,
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => {},
			getExtensionRunner: () =>
				fakeRunner([
					() => {
						hookCalls++;
						return undefined;
					},
				]),
			checkToolApplicability: () => ({
				block: true,
				reason: "The current owner request does not explicitly ask for trello.",
			}),
		});

		const result = await controller.beforeToolCall(
			{
				assistantMessage: fauxAssistantMessage(""),
				toolCall: fauxToolCall("trello", { action: "resolve_project_scope" }, { id: "trello-call" }),
				args: { action: "resolve_project_scope", project: "GrimDex" },
				context: { systemPrompt: "test", messages: [], tools: [] },
			} as Parameters<typeof controller.beforeToolCall>[0],
			undefined,
		);

		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("does not explicitly ask") });
		expect(hookCalls).toBe(0);
	});

	it("a tool call makes no System One evaluation; System One records it with an intent built from its arguments", async () => {
		const { cwd } = scope();
		const recorded: { tool: string; args?: unknown; impact: string; call_id: string }[] = [];
		const terminals: { call_id: string; succeeded: boolean; output: unknown[] }[] = [];
		let evaluations = 0;
		const controller = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => cwd,
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => {},
			getExtensionRunner: () => fakeRunner([]),
			getSystemOneController: () =>
				({
					validateToolGate: async () => {
						evaluations += 1;
						return { outcome: "replan" };
					},
					recordToolCall: (request: { tool: string; args?: unknown; impact: string; call_id: string }) =>
						recorded.push(request),
					recordToolTerminal: (terminal: { call_id: string; succeeded: boolean; output: unknown[] }) =>
						terminals.push(terminal),
				}) as never,
		});
		const calls = [
			invocation("provider-read-id", "read", { path: "src/a.ts" }),
			invocation("provider-bash-id", "bash", { command: "git push origin main" }),
		];
		for (const call of calls) {
			await admit(controller, call);
		}
		for (let index = 0; index < calls.length; index += 1) {
			await finish(controller, calls[index]!, `${index === 0 ? "read" : "bash"} terminal`, false);
		}
		expect(evaluations).toBe(0);
		expect(recorded).toMatchObject([
			{ tool: "read", args: { path: "src/a.ts" }, impact: "read_only" },
			{ tool: "bash", args: { command: "git push origin main" }, impact: "local_reversible" },
		]);
		// Host IDs own local terminal correlation; provider IDs remain protocol input only.
		const hostCallIds = recorded.map((entry) => entry.call_id);
		expect(new Set(hostCallIds).size).toBe(2);
		expect(hostCallIds).not.toContain("provider-read-id");
		expect(hostCallIds).not.toContain("provider-bash-id");
		expect(terminals).toEqual(
			hostCallIds.map((call_id, index) => ({
				call_id,
				succeeded: true,
				output: [{ type: "text", text: `${index === 0 ? "read" : "bash"} terminal` }],
			})),
		);
	});

	it("attributes overlapping same-provider-ID terminals to their own System One events", async () => {
		const { cwd } = scope();
		const systemOne = createSystemOneController("same-provider-call-id");
		const store = ToolPerformanceStore.forAgentDir(tempDir("pi-gate-system-one-selection-id-"));
		const selection = new ToolSelectionController({
			store,
			getModelRef: () => "faux/model",
			getActiveTools: () => [{ name: "read", description: "read a file", pathValidated: true }],
		});
		const selectionBegins = vi.spyOn(selection, "begin");
		const selectionCompletions = vi.spyOn(selection, "complete");
		const gate = createGate(cwd, systemOne, selection);
		const argsA = { path: "src/A.ts" };
		const argsB = { path: "src/B.ts" };
		const callA = invocation("reused-provider-id", "read", argsA);
		const callB = invocation("reused-provider-id", "read", argsB);

		try {
			await admit(gate, callA);
			await admit(gate, callB);
			const admitted = systemOne.store.snapshot().tool_events;
			const eventA = admitted[0]!;
			const eventB = admitted[1]!;
			expect(eventA.input_hash).toBe(payloadHash(argsA));
			expect(eventB.input_hash).toBe(payloadHash(argsB));
			expect(eventA.input_hash).not.toBe(eventB.input_hash);
			expect([eventA.status, eventB.status]).toEqual(["allowed", "allowed"]);
			expect(selectionBegins.mock.calls.map(([callId]) => callId)).toEqual([eventA.call_id, eventB.call_id]);
			expect(eventA.call_id).not.toBe(eventB.call_id);

			await finish(gate, callA, "A failed with a distinct result", true);
			const afterA = systemOne.store.snapshot().tool_events;
			expect(afterA[0]).toMatchObject({
				status: "failed",
				output_hash: payloadHash([{ type: "text", text: "A failed with a distinct result" }]),
			});
			expect(afterA[1]).toMatchObject({ status: "allowed", output_hash: null });
			expect(selectionCompletions.mock.calls.map(([callId]) => callId)).toEqual([eventA.call_id]);

			await finish(gate, callB, "B succeeded with another result", false);
			const afterB = systemOne.store.snapshot().tool_events;
			expect(afterB[0]).toMatchObject({ status: "failed" });
			expect(afterB[1]).toMatchObject({
				status: "succeeded",
				output_hash: payloadHash([{ type: "text", text: "B succeeded with another result" }]),
			});
			expect(afterB[0]!.call_id).not.toBe(afterB[1]!.call_id);
			expect(selectionCompletions.mock.calls.map(([callId]) => callId)).toEqual([eventA.call_id, eventB.call_id]);
		} finally {
			store.close();
		}
	});

	it("negative control: distinct provider IDs retain their own System One terminals", async () => {
		const { cwd } = scope();
		const systemOne = createSystemOneController("distinct-provider-call-ids");
		const gate = createGate(cwd, systemOne);
		const callA = invocation("provider-id-A", "read", { path: "src/A.ts" });
		const callB = invocation("provider-id-B", "read", { path: "src/B.ts" });

		await admit(gate, callA);
		await admit(gate, callB);
		await finish(gate, callA, "A failed", true);
		expect(systemOne.store.snapshot().tool_events.map((event) => event.status)).toEqual(["failed", "allowed"]);
		await finish(gate, callB, "B succeeded", false);
		expect(systemOne.store.snapshot().tool_events.map((event) => event.status)).toEqual(["failed", "succeeded"]);
	});

	it("attributes overlapping same-provider-ID completions to their own tool-selection observations", async () => {
		const { cwd } = scope();
		const store = ToolPerformanceStore.forAgentDir(tempDir("pi-gate-selection-race-"));
		const selection = new ToolSelectionController({
			store,
			getModelRef: () => "faux/model",
			getActiveTools: () => [
				{ name: "read", description: "read a file", pathValidated: true },
				{ name: "grep", description: "search files", pathValidated: true },
			],
		});
		const gate = createGate(cwd, undefined, selection);
		const callA = invocation("reused-provider-id", "read", { path: "src/A.ts" });
		const callB = invocation("reused-provider-id", "grep", { pattern: "B", path: "src" });
		const modelRef = `${callA.assistantMessage.provider}/${callA.assistantMessage.model}`;
		const readKey = { modelRef, intentClass: "read" as const, tool: "read" };
		const grepKey = { modelRef, intentClass: "search" as const, tool: "grep" };

		try {
			await admit(gate, callA);
			await admit(gate, callB);
			await finish(gate, callA, "A failed", true);
			expect(store.get(readKey)).toMatchObject({ sampleCount: 1, failureCount: 1 });
			expect(store.get(grepKey)).toMatchObject({ sampleCount: 0, failureCount: 0 });

			await finish(gate, callB, "B succeeded", false);
			expect(store.get(readKey)).toMatchObject({ sampleCount: 1, failureCount: 1 });
			expect(store.get(grepKey)).toMatchObject({ sampleCount: 1, failureCount: 0 });
		} finally {
			store.close();
		}
	});

	it("an allowed call with no hooks records exactly one allow outcome", async () => {
		const { cwd } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], allowedPaths: [cwd] };
		const { call, outcomes } = createController({ cwd, envelope });
		await expect(call({ path: join(cwd, "a.txt") })).resolves.toBeUndefined();
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ outcome: "allow", gate: "tool_gate", reasonCode: "allowed_by_envelope" });
	});

	it("a pre-hook denial records that denial once and never reaches the hooks", async () => {
		const { cwd } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], deniedTools: ["read"] };
		let hookCalls = 0;
		const { call, outcomes } = createController({
			cwd,
			envelope,
			hooks: [
				() => {
					hookCalls++;
					return undefined;
				},
			],
		});
		const result = await call({ path: join(cwd, "a.txt") });
		expect(result).toMatchObject({ block: true });
		expect(hookCalls).toBe(0);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ outcome: "block", reasonCode: "tool_denied" });
	});

	it("a hook that rewrites the path out of scope is caught by the second evaluation and recorded once", async () => {
		const { cwd, outside } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], allowedPaths: [cwd] };
		const { call, outcomes } = createController({
			cwd,
			envelope,
			hooks: [
				(event) => {
					(event.input as { path: string }).path = join(outside, "secret.txt");
					return undefined;
				},
			],
		});
		const result = await call({ path: join(cwd, "a.txt") });
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("path_scope");
		// Only the final (post-hook) outcome is published, never the pre-hook allow beside it.
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ outcome: "block", gate: "path_scope" });
	});

	it("a hook that keeps the call in scope still yields one allow outcome, from the final evaluation", async () => {
		const { cwd } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], allowedPaths: [cwd] };
		const { call, outcomes } = createController({
			cwd,
			envelope,
			hooks: [
				(event) => {
					(event.input as { path: string }).path = join(cwd, "renamed.txt");
					return undefined;
				},
			],
		});
		await expect(call({ path: join(cwd, "a.txt") })).resolves.toBeUndefined();
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ outcome: "allow", reasonCode: "allowed_by_envelope" });
	});

	it("two distinct calls with the same outcome each publish their own record", async () => {
		const { cwd } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], allowedPaths: [cwd] };
		const { call, outcomes } = createController({ cwd, envelope });
		await call({ path: join(cwd, "a.txt") });
		await call({ path: join(cwd, "a.txt") });
		expect(outcomes).toHaveLength(2);
		expect(outcomes.every((outcome) => outcome.outcome === "allow")).toBe(true);
	});

	it("a hook block keeps its own reason and leaves one (pre-hook) outcome on record", async () => {
		const { cwd } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], allowedPaths: [cwd] };
		const { call, outcomes } = createController({
			cwd,
			envelope,
			hooks: [() => ({ block: true, reason: "policy says no" })],
		});
		await expect(call({ path: join(cwd, "a.txt") })).resolves.toMatchObject({
			block: true,
			reason: "policy says no",
		});
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ outcome: "allow" });
	});

	it("a hook failure still propagates and leaves exactly one outcome on record", async () => {
		const { cwd } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], allowedPaths: [cwd] };
		const { call, outcomes } = createController({
			cwd,
			envelope,
			hooks: [
				() => {
					throw new Error("hook exploded");
				},
			],
		});
		await expect(call({ path: join(cwd, "a.txt") })).rejects.toThrow("hook exploded");
		expect(outcomes).toHaveLength(1);
	});

	it("a call cancelled during the hooks keeps the completed pre-hook decision on record", async () => {
		// The pre-hook evaluation finished before the abort; a later cancellation is not evidence
		// against that decision, so it stays published (once), exactly as the old owner recorded it.
		const { cwd } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], allowedPaths: [cwd] };
		const abort = new AbortController();
		const { call, outcomes } = createController({
			cwd,
			envelope,
			hooks: [
				() => {
					abort.abort();
					return undefined;
				},
			],
		});
		await expect(call({ path: join(cwd, "a.txt") }, abort.signal)).rejects.toThrow();
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ outcome: "allow", reasonCode: "allowed_by_envelope" });
	});

	it("negative control: a call cancelled before any evaluation completes publishes nothing", async () => {
		const { cwd } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], allowedPaths: [cwd] };
		const abort = new AbortController();
		abort.abort();
		let hookCalls = 0;
		const { call, outcomes } = createController({
			cwd,
			envelope,
			hooks: [
				() => {
					hookCalls++;
					return undefined;
				},
			],
		});
		await expect(call({ path: join(cwd, "a.txt") }, abort.signal)).rejects.toThrow();
		expect(hookCalls).toBe(0);
		expect(outcomes).toHaveLength(0);
	});

	it("without an envelope nothing is recorded and the call is admitted", async () => {
		const { cwd } = scope();
		const { call, outcomes } = createController({ cwd, envelope: undefined });
		await expect(call({ path: join(cwd, "a.txt") })).resolves.toBeUndefined();
		expect(outcomes).toHaveLength(0);
	});

	it("the edge is consulted once, after the final evaluation, and its block does not add a second record", async () => {
		const { cwd } = scope();
		const envelope: CapabilityEnvelope = { id: "env", capabilities: ["filesystem.read"], allowedPaths: [cwd] };
		let edgeCalls = 0;
		const { call, outcomes } = createController({
			cwd,
			envelope,
			checkEdge: async () => {
				edgeCalls++;
				return { block: true, reason: "edge says no" };
			},
		});
		await expect(call({ path: join(cwd, "a.txt") })).resolves.toMatchObject({ block: true, reason: "edge says no" });
		expect(edgeCalls).toBe(1);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ outcome: "allow" });
	});

	it("YOLO admits a tool despite harness permission gates while guarded mode still blocks it", async () => {
		const { cwd, outside } = scope();
		const envelope: CapabilityEnvelope = {
			id: "narrow",
			capabilities: [],
			deniedTools: ["read"],
			allowedPaths: [cwd],
		};
		const checked: string[] = [];
		const makeController = (mode: "guarded" | "yolo", selfRegulation?: "compaction" | "router") =>
			new ToolGateController({
				getExecutionMode: () => mode,
				gateSelfCompaction: () =>
					selfRegulation === "compaction" ? { block: true, reason: "compaction" } : undefined,
				maybeEscalateToolCall: () => (selfRegulation === "router" ? { block: true, reason: "router" } : undefined),
				getCwd: () => cwd,
				getCapabilityEnvelope: () => envelope,
				recordGateOutcome: () => {},
				getExtensionRunner: () => fakeRunner([]),
				checkEdge: async () => {
					checked.push("edge");
					return mode === "yolo" ? undefined : { block: true, reason: "edge" };
				},
				checkOperation: async () => {
					checked.push("operation");
					return { block: true, reason: "operation" };
				},
				checkDirectScriptExecution: () => {
					checked.push("script");
					return { block: true, reason: "script" };
				},
				checkExternalAcquisition: async () => {
					checked.push("acquisition");
					return { block: true, reason: "acquisition" };
				},
			});
		const call = (controller: ToolGateController) =>
			controller.beforeToolCall(
				{
					assistantMessage: fauxAssistantMessage(""),
					toolCall: fauxToolCall("read", { path: join(outside, "file") }),
					args: { path: join(outside, "file") },
					context: { systemPrompt: "test", messages: [], tools: [] },
				} as Parameters<typeof controller.beforeToolCall>[0],
				undefined,
			);
		expect(await call(makeController("guarded"))).toMatchObject({ block: true });
		expect(await call(makeController("yolo"))).toBeUndefined();
		expect(checked).toEqual(["edge"]);
		// Context compaction and router escalation are self-regulation, not permission: YOLO keeps both.
		expect(await call(makeController("yolo", "compaction"))).toMatchObject({ block: true, reason: "compaction" });
		expect(await call(makeController("yolo", "router"))).toMatchObject({ block: true, reason: "router" });
	});
});
