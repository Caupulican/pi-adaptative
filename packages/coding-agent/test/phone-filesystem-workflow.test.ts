import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	type Api,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function phoneModel(): Model<Api> {
	return {
		id: "non-native-phone-model",
		name: "Non-native phone model",
		api: "openai-completions",
		provider: "phone-workflow",
		baseUrl: "https://phone.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 2_048,
		textToolCallProtocol: true,
	};
}

function phoneCall(name: string, args: Record<string, unknown>): string {
	return `<pi:call name="${name}">${JSON.stringify(args)}</pi:call>`;
}

function latestIntentId(context: Context, toolName: string): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "toolResult" || message.toolName !== toolName) continue;
		const text = message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		const match = /intentId ([^\s.]+)/.exec(text);
		if (match?.[1]) return match[1];
	}
	throw new Error(`missing ${toolName} intentId in phone workflow context`);
}

describe("non-native phone filesystem workflow", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-phone-filesystem-"));
		mkdirSync(join(root, "project"));
		mkdirSync(join(root, "agent"));
	});

	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("executes read, write, edit, bash, and final read from text envelopes only", async () => {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const sourcePath = join(cwd, "source.txt");
		const targetPath = join(cwd, "target.txt");
		await writeFile(sourcePath, "phone-read-ok", "utf8");

		const responses: Array<string | ((context: Context) => string)> = [
			phoneCall("read", { path: sourcePath }),
			"read complete",
			phoneCall("write", {
				action: "write",
				path: targetPath,
				intentId: "RETURNED_INTENT_ID",
				content: "phone-before",
			}),
			(context) =>
				phoneCall("write", {
					action: "write",
					path: targetPath,
					intentId: latestIntentId(context, "write"),
					content: "phone-before",
				}),
			"write complete",
			phoneCall("edit", {
				action: "edit",
				path: targetPath,
				intentId: "RETURNED_INTENT_ID",
				edits: [{ oldText: "phone-before", newText: "phone-after" }],
			}),
			(context) =>
				phoneCall("edit", {
					action: "edit",
					path: targetPath,
					intentId: latestIntentId(context, "edit"),
					edits: [{ oldText: "phone-before", newText: "phone-after" }],
				}),
			"edit complete",
			phoneCall("bash", { command: `node -e "process.stdout.write('phone-shell-ok')"` }),
			"shell complete",
			phoneCall("read", { path: targetPath }),
			"final read complete",
		];
		let responseIndex = 0;
		const model = phoneModel();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (streamModel, context) => {
				const responseStep = responses[responseIndex++];
				if (responseStep === undefined) throw new Error("phone workflow requested an unexpected response");
				const response = typeof responseStep === "function" ? responseStep(context) : responseStep;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage(response),
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
						},
					});
				});
				return stream;
			},
		});
		const created = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			await created.session.prompt(`Read ${sourcePath}.`);
			expect(created.session.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
				toolName: "read",
				isError: false,
			});
			await created.session.prompt(`Write ${targetPath}.`);
			const writeResult = created.session.messages.filter((message) => message.role === "toolResult").at(-1);
			expect(writeResult, JSON.stringify(writeResult)).toMatchObject({
				toolName: "write",
				isError: false,
			});
			await created.session.prompt(`Edit ${targetPath}.`);
			expect(created.session.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
				toolName: "edit",
				isError: false,
			});
			await created.session.prompt("Run the shell marker command.");
			expect(created.session.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
				toolName: "bash",
				isError: false,
			});
			await created.session.prompt(`Read ${targetPath}.`);

			expect(await readFile(targetPath, "utf8")).toBe("phone-after");
			expect(responseIndex).toBe(responses.length);
			const toolResults = created.session.messages.filter((message) => message.role === "toolResult");
			expect(toolResults.map((message) => message.toolName)).toEqual([
				"read",
				"write",
				"write",
				"edit",
				"edit",
				"bash",
				"read",
			]);
			expect(toolResults.every((message) => !message.isError)).toBe(true);
			expect(JSON.stringify(toolResults)).toContain("phone-read-ok");
			expect(JSON.stringify(toolResults)).toContain("phone-shell-ok");
			expect(JSON.stringify(toolResults)).toContain("phone-after");
			const phoneCalls = created.session.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => message.content)
				.filter((content) => content.type === "toolCall");
			expect(phoneCalls).toHaveLength(7);
			expect(phoneCalls.every((call) => call.source === "text-protocol")).toBe(true);
			expect(phoneCalls.filter((call) => call.name === "write")[0]?.arguments).toEqual({
				action: "prepare",
				path: targetPath,
			});
			expect(phoneCalls.filter((call) => call.name === "edit")[0]?.arguments).toEqual({
				action: "prepare",
				path: targetPath,
			});
		} finally {
			created.session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});
});
