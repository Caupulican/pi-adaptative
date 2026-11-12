import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	createEmptyUsage,
	type Model,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/kernel/agent-loop.ts";
import type { ExecutionContext } from "../src/kernel/execution-context.ts";
import type { AgentContext, AgentLoopConfig } from "../src/kernel/loop-config.ts";
import { convertToLlm } from "../src/kernel/messages.ts";
import type { AgentTool } from "../src/kernel/types.ts";

const model: Model<Api> = {
	id: "text-replay-fixture",
	name: "Text replay fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const schema = Type.Object({
	path: Type.String(),
	oldText: Type.Optional(Type.String()),
	newText: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	timeout: Type.Optional(Type.Number()),
	mode: Type.Optional(Type.String()),
});
type Arguments = {
	path: string;
	oldText?: string;
	newText?: string;
	content?: string;
	timeout?: number;
	mode?: string;
};
type Call = { name: "edit" | "write"; args: Arguments };
const prompt = { role: "user" as const, content: "Make the requested changes.", timestamp: 1 };
const contextOf = (generation: number): ExecutionContext => ({
	attachment: {
		workspaceId: "workspace",
		attachmentId: "attachment",
		root: "/workspace",
		flavor: "posix",
		caseSensitive: true,
	},
	sessionId: "session",
	generation,
	cwd: "/workspace",
});

function tool(
	name: Call["name"],
	executed: Call[],
	options: { scopes?: number[]; releases?: number[]; preparedModes?: string[] } = {},
): AgentTool<typeof schema> {
	let bindings = 0;
	let preparations = 0;
	const execute: AgentTool<typeof schema>["execute"] = async (_id, args) => {
		const existed = executed.some((call) => call.name === "write" && call.args.path === args.path);
		executed.push({ name, args: { ...args } });
		return existed && name === "write"
			? { content: [{ type: "text", text: "create collision" }], details: undefined, isError: true }
			: { content: [{ type: "text", text: "success" }], details: undefined };
	};
	return {
		name,
		label: name,
		description: `${name} fixture`,
		parameters: schema,
		execute,
		...(options.preparedModes
			? {
					prepareArguments: (args: unknown) => ({
						...(args as Arguments),
						mode: options.preparedModes![Math.min(preparations++, options.preparedModes!.length - 1)]!,
					}),
				}
			: {}),
		...(options.scopes
			? {
					bindInvocation: async () => {
						const index = bindings++;
						return {
							executionContext: contextOf(options.scopes![Math.min(index, options.scopes!.length - 1)]!),
							execute,
							release: () => {
								options.releases?.push(index);
							},
						};
					},
				}
			: {}),
	};
}

async function run(batches: Call[][], tools: AgentTool[]): Promise<{ executedResults: string[] }> {
	let turn = 0;
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		textToolCallProtocol: true,
		toolExecution: "sequential",
		maxStallTurns: 0,
		maxRepeatedFailures: 0,
		maxProviderTurns: 4,
	};
	const context: AgentContext = { systemPrompt: "Follow the owner.", messages: [], tools };
	const messages = await runAgentLoop(
		[prompt],
		context,
		config,
		() => {},
		undefined,
		() => {
			const batch = batches[turn++];
			const text = batch
				? batch
						.map(({ name, args }) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`)
						.join("\n")
				: "Finished.";
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "text", text }],
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: turn,
			};
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		},
	);
	return {
		executedResults: messages
			.filter((message) => message.role === "toolResult")
			.flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text)),
	};
}
const edit = (oldText: string, newText: string, path = "/workspace/file.txt"): Call => ({
	name: "edit",
	args: { path, oldText, newText },
});
const write = (content: string): Call => ({ name: "write", args: { path: "/workspace/file.txt", content } });

describe("text-protocol successful-operation replay", () => {
	it("refuses the exact successful operation without executing it twice", async () => {
		const calls: Call[] = [];
		const call = edit("old", "new");
		const result = await run([[call], [call]], [tool("edit", calls)]);
		expect(calls).toHaveLength(1);
		expect(result.executedResults.join("\n")).toContain("already succeeded and was not executed again");
	});
	it("executes changed edit content on the same path", async () => {
		const calls: Call[] = [];
		await run([[edit("old", "first")], [edit("first", "second")]], [tool("edit", calls)]);
		expect(calls.map((call) => call.args.newText)).toEqual(["first", "second"]);
	});
	it("allows a changed write to reach the tool's create-collision decision", async () => {
		const calls: Call[] = [];
		const result = await run([[write("first")], [write("second")]], [tool("write", calls)]);
		expect(calls.map((call) => call.args.content)).toEqual(["first", "second"]);
		expect(result.executedResults.join("\n")).toContain("create collision");
	});
	it("runs an ordered batch again when one edit changed", async () => {
		const calls: Call[] = [];
		const a = edit("a", "b", "/workspace/a.txt");
		await run(
			[
				[a, edit("x", "y", "/workspace/b.txt")],
				[a, edit("y", "z", "/workspace/b.txt")],
			],
			[tool("edit", calls)],
		);
		expect(calls.map((call) => call.args.newText)).toEqual(["b", "y", "b", "z"]);
	});
	it("still refuses the same operation when only its resource timeout changes", async () => {
		const calls: Call[] = [];
		const call = edit("old", "new");
		await run(
			[[{ ...call, args: { ...call.args, timeout: 1 } }], [{ ...call, args: { ...call.args, timeout: 2 } }]],
			[tool("edit", calls)],
		);
		expect(calls).toHaveLength(1);
	});
	it.each([
		{ scopes: [1, 1], expected: 1 },
		{ scopes: [1, 2], expected: 2 },
	])("uses bound execution scope $scopes", async ({ scopes, expected }) => {
		const calls: Call[] = [];
		const releases: number[] = [];
		const call = edit("old", "new");
		await run([[call], [call]], [tool("edit", calls, { scopes, releases })]);
		expect(calls).toHaveLength(expected);
		expect(releases).toEqual([0, 1]);
	});
	it.each([false, true])("refuses stable prepared defaults with bound executor %s", async (bound) => {
		const calls: Call[] = [];
		const call = edit("old", "new");
		const result = await run(
			[[call], [call]],
			[
				tool("edit", calls, {
					preparedModes: ["stable", "stable"],
					...(bound ? { scopes: [1, 1] } : {}),
				}),
			],
		);
		expect(calls.map((item) => item.args.mode)).toEqual(["stable"]);
		expect(result.executedResults.join("\n")).toContain("already succeeded and was not executed again");
	});
	it.each([false, true])(
		"executes changed prepared arguments with identical raw input and bound executor %s",
		async (bound) => {
			const calls: Call[] = [];
			const call = edit("old", "new");
			await run(
				[[call], [call]],
				[
					tool("edit", calls, {
						preparedModes: ["first", "second"],
						...(bound ? { scopes: [1, 1] } : {}),
					}),
				],
			);
			expect(calls.map((item) => item.args.mode)).toEqual(["first", "second"]);
		},
	);
});
