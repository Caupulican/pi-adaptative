import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeToolCallResult } from "@caupulican/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityEnvelope, GateOutcome } from "../src/core/autonomy/contracts.ts";
import type { ExtensionRunner } from "../src/core/extensions/index.ts";
import type { ToolCallEvent, ToolCallEventResult } from "../src/core/extensions/types.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";

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
			{ toolCall: { id: `call-${outcomes.length + 1}`, name: "read", arguments: args }, args } as Parameters<
				typeof controller.beforeToolCall
			>[0],
			signal,
		);
	return { call, outcomes };
}

describe("ToolGateController publishes one gate outcome per tool call", () => {
	const tempDirs: string[] = [];
	function scope(): { cwd: string; outside: string } {
		const cwd = mkdtempSync(join(tmpdir(), "pi-gate-outcomes-"));
		const outside = mkdtempSync(join(tmpdir(), "pi-gate-outside-"));
		tempDirs.push(cwd, outside);
		return { cwd, outside };
	}
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
});
