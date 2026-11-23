import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type AssistantMessage, AssistantMessageEventStream, createEmptyUsage, type Model } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { WorkerMutationEvidence } from "../src/core/delegation/worker-mutation-evidence.ts";
import { collectClaimReceipts } from "../src/core/system-one/claim-delivery.ts";
import type { NestedCallHost } from "../src/core/tools/nested-tool-call.ts";
import { openToolBridge, toolBridgeFailureReceipt } from "../src/core/tools/tool-bridge.ts";
import { MAX_TOOL_BRIDGE_CALLS } from "../src/core/tools/tool-bridge-policy.ts";
import {
	type AgentTool,
	compactRetainedDetails,
	convertToLlm,
	runAgentLoop,
	stampToolInvocation,
} from "../src/kernel/index.ts";

function pythonReceipt(args: Record<string, unknown>, details: Record<string, unknown> | undefined, isError = false) {
	return collectClaimReceipts([
		{
			role: "assistant",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			usage: createEmptyUsage(),
			timestamp: 1,
			stopReason: "toolUse",
			content: [{ type: "toolCall", name: "python", id: "call-py", arguments: args }],
		},
		{
			role: "toolResult",
			toolName: "python",
			toolCallId: "call-py",
			timestamp: 2,
			content: [{ type: "text", text: "done" }],
			details,
			isError,
		},
	]);
}

it("collects host-observed paths even if the parent script fails and rejects unbacked claims", () => {
	const validBridge = {
		tools: ["read", "edit", "write"] as const,
		calls: 4,
		byTool: { read: 1, edit: 2, write: 1 },
		outcomes: { ok: 4, refused: 0, error: 0, limit: 0, cancelled: 0 },
		authFailures: 0,
		ms: 12,
		trace: [],
		changedPaths: ["a.ts", "b.ts", "a.ts"],
	};
	expect(
		pythonReceipt({ code: "import pi_tools", tools: ["read", "edit", "write"] }, { toolBridge: validBridge })
			.filesChanged,
	).toEqual(["a.ts", "b.ts"]);

	const args = { code: "import pi_tools", tools: ["edit", "write"] };
	const scriptStakes = { status: "unread", reason: "outside read scope" };
	const failure = toolBridgeFailureReceipt(validBridge, { scriptStakes });
	expect(failure?.scriptStakes).toEqual(scriptStakes);
	for (const execution of ["completed", "unknown"] as const) {
		const reply = {
			details: stampToolInvocation(failure, {
				version: 1,
				requestId: `failed-${execution}`,
				...(execution === "completed" ? { execution, operationStatus: "error" } : { execution }),
				postprocessingFailures: [],
			}),
		};
		compactRetainedDetails(reply, 1);
		const receipts = pythonReceipt(args, reply.details, true);
		expect(receipts.filesChanged).toEqual(["a.ts", "b.ts"]);
		expect(receipts.succeededToolCalls).toBe(0);
	}
	expect(toolBridgeFailureReceipt({ ...validBridge, changedPaths: ["x".repeat(1_000)] }, undefined)).toMatchObject({
		toolBridge: { changedPaths: [], omittedChangedPaths: 1 },
	});
	expect(
		pythonReceipt({ code: "import pi_tools", tools: ["read"] }, { toolBridge: validBridge }).filesChanged,
	).toEqual([]);
	expect(pythonReceipt({ code: 'Path("a.ts").write_text("x")' }, { toolBridge: validBridge }).filesChanged).toEqual(
		[],
	);
	expect(
		pythonReceipt(
			{ code: "import pi_tools", tools: ["edit"] },
			{ toolBridge: { ...validBridge, outcomes: { ...validBridge.outcomes, ok: 1 } } },
		).filesChanged,
	).toEqual([]);
	expect(
		pythonReceipt(
			{ code: "import pi_tools", tools: ["edit"] },
			{
				toolBridge: {
					...validBridge,
					outcomes: { ...validBridge.outcomes, ok: MAX_TOOL_BRIDGE_CALLS + 1 },
					changedPaths: Array.from({ length: MAX_TOOL_BRIDGE_CALLS + 1 }, (_, i) => `f-${i}.ts`),
				},
			},
		).filesChanged,
	).toEqual([]);
});

it("records deduplicated changedPaths in openToolBridge only for admitted, succeeded edit/write calls", async () => {
	const pathSchema = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: true });
	const makeTool = (name: string, failPath?: string): AgentTool<typeof pathSchema> => ({
		name,
		label: name,
		description: name,
		parameters: pathSchema,
		async execute(_id, args) {
			if (failPath && args.path === failPath) throw new Error("write failed");
			return { content: [{ type: "text", text: `${name}:${args.path}` }], details: {} };
		},
	});
	const tools = new Map<string, AgentTool>([
		["read", makeTool("read")],
		["edit", makeTool("edit", "fail.ts")],
		["write", makeTool("write")],
	]);
	const host: NestedCallHost = {
		resolveTool: (name) => tools.get(name),
		admit: async (_parentId, call) => {
			if (call.args.path === "blocked.ts") return { kind: "refused", reason: "blocked" };
			return {
				kind: "admitted",
				start() {},
				finish: async (result, isError) => ({ content: result.content, details: result.details, isError }),
				abandon() {},
				consume() {},
			};
		},
	};

	const bridge = await openToolBridge({
		host,
		parentToolCallId: "parent-1",
		tools: ["read", "edit", "write"],
		maxCalls: 10,
	});
	try {
		const token = await readFile(bridge.environment.PI_TOOL_BRIDGE_TOKEN_FILE!, "utf8");
		const socket = connect(bridge.environment.PI_TOOL_BRIDGE!);
		const lines = createInterface({ input: socket });
		const iter = lines[Symbol.asyncIterator]();
		const send = async (frame: Record<string, unknown>) => {
			socket.write(`${JSON.stringify(frame)}\n`);
			const next = await iter.next();
			return JSON.parse(next.value ?? "{}") as Record<string, unknown>;
		};
		try {
			expect(await send({ t: "hello", token })).toEqual({ t: "ready" });
			expect((await send({ t: "call", id: 1, tool: "read", args: { path: "only-read.ts" } })).ok).toBe(true);
			expect((await send({ t: "call", id: 2, tool: "edit", args: { path: "first.ts" } })).ok).toBe(true);
			expect((await send({ t: "call", id: 3, tool: "edit", args: { path: "blocked.ts" } })).ok).toBe(false);
			expect((await send({ t: "call", id: 4, tool: "edit", args: { path: "fail.ts" } })).ok).toBe(false);
			expect((await send({ t: "call", id: 5, tool: "write", args: { path: "second.ts" } })).ok).toBe(true);
			expect((await send({ t: "call", id: 6, tool: "edit", args: { path: "first.ts" } })).ok).toBe(true);
		} finally {
			lines.close();
			socket.destroy();
		}
	} finally {
		const report = await bridge.close();
		expect(report.changedPaths).toEqual(["first.ts", "second.ts"]);
	}
});

it("keeps a settled child write when an after-tool hook rejects its parent's result", async () => {
	const model: Model<"openai-completions"> = {
		id: "bridge-fixture",
		name: "Bridge fixture",
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://unused.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 100_000,
		maxTokens: 1_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const args = { tools: ["write"] };
	const python: AgentTool = {
		name: "python",
		label: "Python",
		description: "Run a script",
		parameters: Type.Object({ tools: Type.Array(Type.String()) }),
		async execute() {
			const bridge = {
				tools: ["write"] as const,
				calls: 1,
				byTool: { write: 1 },
				outcomes: { ok: 1, refused: 0, error: 0, limit: 0, cancelled: 0 },
				ms: 1,
				authFailures: 0,
				trace: [],
				changedPaths: ["written.ts"],
			};
			const failureReceipt = toolBridgeFailureReceipt(bridge, undefined);
			return { content: [{ type: "text", text: "Finished" }], details: { toolBridge: bridge }, failureReceipt };
		},
	};
	let first = true;
	const messages = await runAgentLoop(
		[{ role: "user", content: "Write the fixture file.", timestamp: 1 }],
		{ systemPrompt: "Follow the owner.", messages: [], tools: [python] },
		{ model, convertToLlm, afterToolCall: async () => ({ isError: true, details: {} }) },
		() => {},
		undefined,
		() => {
			const reason = first ? "toolUse" : "stop";
			const response: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: first
					? [{ type: "toolCall", id: "bridge-call", name: "python", arguments: args }]
					: [{ type: "text", text: "The file was written." }],
				stopReason: reason,
				usage: createEmptyUsage(),
				timestamp: 2,
			};
			first = false;
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial: response });
			stream.push({ type: "done", reason, message: response });
			return stream;
		},
	);
	expect(collectClaimReceipts(messages).filesChanged).toEqual(["written.ts"]);
	expect(messages.find((message) => message.role === "toolResult")).toMatchObject({ isError: true });
});

it("records settled worker bridge writes after a failed parent while keeping process uncertainty", () => {
	const repoRoot = resolve("fixture-repo");
	const persisted: string[] = [];
	const owned: string[] = [];
	const evidence = new WorkerMutationEvidence({
		attemptId: "attempt-1",
		cwd: repoRoot,
		shellReadOnly: false,
		store: {
			getMutationProgress: () => ({ changedFiles: [], uncertain: false, matched: true }),
			recordChangedFile: (_attemptId, filePath) => persisted.push(filePath),
			recordNativeWriteProgress: () => undefined,
			recordUncertainMutation: () => undefined,
		},
		onOwnedWrite: (filePath) => owned.push(filePath),
		onPersistenceFailure: (message) => {
			throw new Error(message);
		},
	});
	const args = { code: "import pi_tools", tools: ["edit", "write"] };
	evidence.start("call-1", "python", args);
	evidence.end("call-1", {
		isError: true,
		details: {
			toolBridge: {
				tools: ["edit", "write"],
				calls: 2,
				byTool: { edit: 1, write: 1 },
				outcomes: { ok: 2, refused: 0, error: 0, limit: 0, cancelled: 0 },
				authFailures: 0,
				ms: 5,
				trace: [],
				changedPaths: ["src/a.ts", join(repoRoot, "src", "b.ts")],
			},
		},
	});
	expect([...evidence.changedFiles]).toEqual(["src/a.ts", "src/b.ts"]);
	expect(persisted).toEqual(["src/a.ts", "src/b.ts"]);
	expect(owned).toEqual(["src/a.ts", "src/b.ts"]);
	expect(evidence.finding()).toBeDefined();
});
