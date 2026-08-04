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
	type ToolCall,
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
				path: targetPath,
				content: "phone-before",
			}),
			"write complete",
			phoneCall("edit", {
				path: targetPath,
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
			expect(toolResults.map((message) => message.toolName)).toEqual(["read", "write", "edit", "bash", "read"]);
			expect(toolResults.every((message) => !message.isError)).toBe(true);
			expect(JSON.stringify(toolResults)).toContain("phone-read-ok");
			expect(JSON.stringify(toolResults)).toContain("phone-shell-ok");
			expect(JSON.stringify(toolResults)).toContain("phone-after");
			const phoneCalls = created.session.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => message.content)
				.filter((content) => content.type === "toolCall");
			expect(phoneCalls).toHaveLength(5);
			expect(phoneCalls.every((call) => call.source === "text-protocol")).toBe(true);
			expect(phoneCalls.filter((call) => call.name === "write")).toMatchObject([
				{
					name: "write",
					arguments: { path: targetPath, content: "phone-before" },
				},
			]);
			expect(phoneCalls.filter((call) => call.name === "edit")).toMatchObject([
				{
					name: "edit",
					arguments: {
						path: targetPath,
						edits: [{ oldText: "phone-before", newText: "phone-after" }],
					},
				},
			]);
		} finally {
			created.session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("retargets a collided write from bounded repair guidance without regenerating content", async () => {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const occupiedPath = join(cwd, "occupied.txt");
		const correctedPath = join(cwd, "corrected.txt");
		const generatedContent = "generated-once-through-phone";
		await writeFile(occupiedPath, "existing", "utf8");
		let repairContextChecked = false;
		let repairSystemPrompt = "";
		let repairMessages = "";
		const responses: Array<string | ((context: Context) => string)> = [
			phoneCall("write", { path: occupiedPath, content: generatedContent }),
			(context) => {
				repairContextChecked = true;
				repairSystemPrompt = context.systemPrompt ?? "";
				repairMessages = JSON.stringify(context.messages);
				const payloadRef = repairSystemPrompt.match(/\bfile-mutation:[0-9a-f-]+\b/i)?.[0];
				if (!payloadRef) throw new Error("Expected retained payload reference in phone repair guidance.");
				return phoneCall("write", { path: correctedPath, payloadRef });
			},
			"retarget complete",
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
				if (responseStep === undefined) throw new Error("phone retarget requested an unexpected response");
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
			await created.session.prompt(`Write the generated content without replacing ${occupiedPath}.`);

			expect(repairContextChecked).toBe(true);
			expect(repairSystemPrompt).toContain("mutation_retarget_required");
			expect(repairSystemPrompt).not.toContain(generatedContent);
			expect(repairMessages).not.toContain(generatedContent);
			expect(responseIndex).toBe(responses.length);
			expect(await readFile(occupiedPath, "utf8")).toBe("existing");
			expect(await readFile(correctedPath, "utf8")).toBe(generatedContent);
			const writeResults = created.session.messages.filter(
				(message) => message.role === "toolResult" && message.toolName === "write",
			);
			expect(writeResults.at(-1), JSON.stringify(created.session.messages)).toMatchObject({ isError: false });
			const writeCalls = created.session.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => message.content)
				.filter((content): content is ToolCall => content.type === "toolCall" && content.name === "write");
			expect(writeCalls).toHaveLength(2);
			expect(writeCalls[0]?.arguments).toEqual({ path: occupiedPath, content: generatedContent });
			expect(writeCalls[1]?.arguments).toMatchObject({
				path: correctedPath,
				payloadRef: expect.stringMatching(/^file-mutation:/),
			});
		} finally {
			created.session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("retargets a path-only edit failure from bounded repair guidance without regenerating edits", async () => {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const missingPath = join(cwd, "missing.txt");
		const correctedPath = join(cwd, "corrected-edit.txt");
		const oldText = "edit-generated-once-before";
		const newText = "edit-generated-once-after";
		await writeFile(correctedPath, oldText, "utf8");
		let repairContextChecked = false;
		let repairSystemPrompt = "";
		let repairMessages = "";
		const responses: Array<string | ((context: Context) => string)> = [
			phoneCall("edit", { path: missingPath, edits: [{ oldText, newText }] }),
			(context) => {
				repairContextChecked = true;
				repairSystemPrompt = context.systemPrompt ?? "";
				repairMessages = JSON.stringify(context.messages);
				const payloadRef = repairSystemPrompt.match(/\bfile-mutation:[0-9a-f-]+\b/i)?.[0];
				if (!payloadRef) throw new Error("Expected retained edit payload reference in phone repair guidance.");
				return phoneCall("edit", { path: correctedPath, payloadRef });
			},
			"retarget complete",
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
				if (responseStep === undefined) throw new Error("phone edit retarget requested an unexpected response");
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
			await created.session.prompt(`Edit the intended file even though ${missingPath} is the wrong name.`);

			expect(repairContextChecked).toBe(true);
			expect(repairSystemPrompt).toContain("mutation_retarget_required");
			expect(repairSystemPrompt).toContain("edit_missing (ENOENT)");
			expect(repairSystemPrompt).not.toContain(oldText);
			expect(repairSystemPrompt).not.toContain(newText);
			expect(repairMessages).not.toContain(oldText);
			expect(repairMessages).not.toContain(newText);
			expect(responseIndex).toBe(responses.length);
			expect(await readFile(correctedPath, "utf8")).toBe(newText);
			const editResults = created.session.messages.filter(
				(message) => message.role === "toolResult" && message.toolName === "edit",
			);
			expect(editResults.at(-1), JSON.stringify(created.session.messages)).toMatchObject({ isError: false });
			const editCalls = created.session.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => message.content)
				.filter((content): content is ToolCall => content.type === "toolCall" && content.name === "edit");
			expect(editCalls).toHaveLength(2);
			expect(editCalls[0]?.arguments).toEqual({ path: missingPath, edits: [{ oldText, newText }] });
			expect(editCalls[1]?.arguments).toMatchObject({
				path: correctedPath,
				payloadRef: expect.stringMatching(/^file-mutation:/),
			});
		} finally {
			created.session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});
});
