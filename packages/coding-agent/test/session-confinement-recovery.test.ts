import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { startNestedCall } from "../src/core/tools/nested-tool-call.ts";
import { retainedToolFailureMemory } from "../src/kernel/tool-failure-memory.ts";
import { retainedToolInvocation } from "../src/kernel/tool-invocation-receipt.ts";
import { AgentToolPolicyDeniedError } from "../src/kernel/types.ts";
import { calls, HARNESS_API, HARNESS_PROVIDER, ScriptedProvider, text } from "./fixtures/harness/scripted-provider.ts";

it("keeps a refused absolute path outside the project and reads the owner's relative file in the same turn", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-confined-recovery-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const privateDir = join(cwd, "private");
	const sibling = join(root, "util.ts");
	const allowed = "The project value is copper.";
	const outside = "The sibling value is tin.";
	const hidden = "The private value is pewter.";
	const provider = new ScriptedProvider("session-confinement-recovery");
	try {
		mkdirSync(privateDir, { recursive: true });
		writeFileSync(join(cwd, "util.ts"), allowed);
		writeFileSync(sibling, outside);
		writeFileSync(join(privateDir, "util.ts"), hidden);
		symlinkSync(privateDir, join(cwd, "linked"), "junction");

		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const model = provider.model("root");
		modelRegistry.registerProvider(HARNESS_PROVIDER, {
			api: HARNESS_API,
			baseUrl: model.baseUrl,
			apiKey: "synthetic",
			models: [model],
		});
		provider.register();
		const settingsManager = SettingsManager.inMemory({
			memorySystem: "okf",
			proactivity: { enabled: false },
			autoLearn: { enabled: false },
			modelRouter: { enabled: false },
			modelCapability: { mode: "off" },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			agentDir,
			cwd,
			settingsManager,
			installMissingPackages: false,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			noPromptTemplates: true,
		});
		await resourceLoader.reload();
		const { session, sessionManager } = await createAgentSession({
			agentDir,
			cwd,
			authStorage,
			modelRegistry,
			model,
			settingsManager,
			resourceLoader,
			pinnedModel: true,
			tools: ["read", "write"],
			systemOneEnabled: false,
			privatePathScope: { readRoots: [cwd], writeRoots: [cwd], deniedPaths: [privateDir], confinedWrites: true },
		});
		try {
			provider.enqueue(
				"root",
				calls("refused-paths", [
					{ id: "sibling-read", name: "read", arguments: { path: sibling } },
					{ id: "symlink-read", name: "read", arguments: { path: "linked/util.ts" } },
					{ id: "sibling-write", name: "write", arguments: { path: sibling, content: "replacement" } },
				]),
				calls("owner-relative-read", [{ id: "allowed-read", name: "read", arguments: { path: "util.ts" } }]),
				text("answer", allowed),
			);
			await session.prompt("Read the project-relative util.ts and report its value.");
			await session.waitForForegroundIdle();
			provider.assertDrained();
			const entries = sessionManager.getBranch();
			expect(entries.filter((e) => e.type === "message" && e.message.role === "user")).toHaveLength(1);
			const results = entries.flatMap((e) =>
				e.type === "message" && e.message.role === "toolResult" ? [e.message] : [],
			);
			expect(results.map((r) => r.toolCallId).sort()).toEqual([
				"allowed-read",
				"sibling-read",
				"sibling-write",
				"symlink-read",
			]);
			for (const result of results.filter((r) => r.toolCallId !== "allowed-read")) {
				expect(result.isError).toBe(true);
				expect(retainedToolInvocation(result.details)).toMatchObject({ execution: "not_started" });
				expect(retainedToolFailureMemory(result.details)).toMatchObject({
					state: "rejected",
					phase: "policy",
					failureCode: "blocked",
				});
			}
			const retryContext = JSON.stringify(provider.requests[1]!.context.messages);
			expect(retryContext).toContain("pass that relative path exactly as given");
			const read = results.find((r) => r.toolCallId === "allowed-read")!;
			expect(retainedToolInvocation(read.details)).toMatchObject({
				execution: "completed",
				operationStatus: "success",
			});
			expect(read.content).toContainEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining(allowed) }),
			);
			const received = JSON.stringify(provider.requests.map((r) => r.context.messages));
			expect(received).not.toContain(outside);
			expect(received).not.toContain(hidden);
			expect(readFileSync(sibling, "utf8")).toBe(outside);
			expect(readFileSync(join(cwd, "util.ts"), "utf8")).toBe(allowed);
			expect(session.getLastAssistantText()).toBe(allowed);
		} finally {
			await session.disposeAndWait();
		}
	} finally {
		await provider.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

it("abandons an admitted nested call once when its executor refuses before dispatch", async () => {
	const correction = "Use the project-relative path from the request.";
	const abandon = vi.fn();
	const finish = vi.fn();
	const start = vi.fn();
	const call = await startNestedCall(
		{
			resolveTool: () => ({
				name: "read",
				label: "Read",
				description: "Read a scoped file",
				parameters: Type.Object({ path: Type.String() }),
				execute: async () => {
					throw new AgentToolPolicyDeniedError("Outside the read scope.", undefined, correction);
				},
			}),
			admit: async () => ({ kind: "admitted", start, finish, abandon, consume: vi.fn() }),
		},
		"lookup",
		"lookup#1",
		"read",
		{ path: "../file" },
		undefined,
	);
	if (!("run" in call)) throw new Error("The child should be admitted before the executor checks the path");
	expect(await call.run()).toMatchObject({
		status: "refused",
		text: `refused: Outside the read scope. ${correction}`,
	});
	expect(start).toHaveBeenCalledTimes(1);
	expect(abandon).toHaveBeenCalledTimes(1);
	expect(finish).not.toHaveBeenCalled();
});
