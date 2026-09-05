import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createHarness, getAssistantTexts, getUserTexts } from "./harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./test-resources.ts";

describe("runtime update continuation", () => {
	it.each(["validation", "commit"] as const)(
		"restores stopped observers after %s failure without restarting an untouched lifecycle",
		async (failurePhase) => {
			let watching = false;
			const start = vi.fn(() => {
				watching = true;
			});
			const shutdown = vi.fn(() => {
				watching = false;
			});
			const previous = await createTestExtensionsResult([
				(pi) => {
					pi.on("session_start", start);
					pi.on("session_shutdown", shutdown);
				},
			]);
			let loaded = previous;
			const loader = createTestResourceLoader();
			loader.getExtensions = () => loaded;
			loader.reload = async () => {
				loaded = await createTestExtensionsResult([() => {}]);
				if (failurePhase === "validation") loaded.errors.push({ path: "candidate", error: "rejected" });
			};
			loader.rollbackReload = async () => {
				loaded = previous;
			};
			loader.commitReload = async () => {
				throw new Error("resource commit rejected");
			};
			const harness = await createHarness({ resourceLoader: loader });
			await harness.session.bindExtensions({ onError: () => {} });
			const prefix = JSON.stringify(harness.session.messages);
			expect(watching).toBe(true);
			expect(start).toHaveBeenCalledTimes(1);

			await expect(harness.session.reload()).rejects.toThrow(/rejected/);

			expect(watching).toBe(true);
			expect(shutdown).toHaveBeenCalledTimes(failurePhase === "commit" ? 1 : 0);
			expect(start).toHaveBeenCalledTimes(failurePhase === "commit" ? 2 : 1);
			expect(JSON.stringify(harness.session.messages)).toBe(prefix);
		},
	);

	it("keeps the previous extension API usable when final resource commit fails", async () => {
		let previousApi: ExtensionAPI | undefined;
		let loaded = await createTestExtensionsResult([
			(pi) => {
				previousApi = pi;
			},
		]);
		const loader = createTestResourceLoader();
		loader.getExtensions = () => loaded;
		loader.reload = async () => {
			loaded = await createTestExtensionsResult([() => {}]);
		};
		loader.commitReload = async () => {
			throw new Error("resource commit rejected");
		};
		const harness = await createHarness({ resourceLoader: loader });
		const previousRunner = harness.session.extensionRunner;
		expect(() => previousApi!.getActiveTools()).not.toThrow();
		await expect(harness.session.reload()).rejects.toThrow("resource commit rejected");
		expect(harness.session.extensionRunner).toBe(previousRunner);
		expect(() => previousApi!.getActiveTools()).not.toThrow();
	});

	it("repairs a broken new extension, activates it and verifies it before returning to the task", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-update-extension-"));
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "new-extension.ts");
		writeFileSync(path, "export default () => { throw new Error('broken draft'); };\n");
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true });
		await loader.reload();
		const harness = await createHarness({ resourceLoader: loader });
		const source = `export default (pi) => { pi.registerTool({name:'new_probe', label:'Probe', description:'Verify new code', parameters:{type:'object',properties:{}}, execute:async()=>({content:[{type:'text',text:'new-code-verified'}],details:{}})}); };`;
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("runtime_update", { action: "reload", extensionPath: path, verificationTool: "new_probe" })],
				{ stopReason: "toolUse" },
			),
			() => {
				expect(harness.session.runtimeUpdates.getState()).toMatchObject({ status: "repairing", attempts: 1 });
				expect(harness.session.getActiveToolNames()).not.toContain("new_probe");
				return fauxAssistantMessage(
					[
						fauxToolCall("edit", {
							path,
							edits: [
								{ oldText: "export default () => { throw new Error('broken draft'); };", newText: source },
							],
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage([fauxToolCall("runtime_update", { action: "reload" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("new_probe", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("runtime_update", { action: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("original task resumed"),
		]);
		await harness.session.prompt("Build this new tool, activate it, and resume my task");
		expect(harness.session.runtimeUpdates.getState()).toMatchObject({ status: "complete", attempts: 2 });
		expect(getAssistantTexts(harness).at(-1)).toBe("original task resumed");
		expect(getUserTexts(harness)).toHaveLength(1);
	});

	it("finishes the tool batch, reloads, verifies the new tool and resumes without replaying the user", async () => {
		let generation = 0;
		let sideCallFinished = false;
		const extensions = () =>
			createTestExtensionsResult([
				(pi) => {
					const loadedGeneration = generation;
					pi.registerTool({
						name: "generation_probe",
						label: "Probe",
						description: "Check the loaded generation",
						parameters: Type.Object({}),
						async execute() {
							sideCallFinished = true;
							return { content: [{ type: "text", text: `generation=${loadedGeneration}` }], details: {} };
						},
					});
				},
			]);
		let loaded = await extensions();
		const loader = createTestResourceLoader();
		loader.getExtensions = () => loaded;
		const harness = await createHarness({ resourceLoader: loader });
		let prefix: string | undefined;
		const reload = vi.fn(async () => {
			expect(harness.session.isStreaming).toBe(false);
			expect(sideCallFinished).toBe(true);
			prefix = JSON.stringify(harness.session.messages.slice(0, 4));
			generation++;
			loaded = await extensions();
		});
		loader.reload = reload;
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("runtime_update", { action: "reload", verificationTool: "generation_probe" }),
					fauxToolCall("generation_probe", {}),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				expect(reload).toHaveBeenCalledTimes(1);
				const messages = harness.session.messages;
				expect(prefix).toBeDefined();
				expect(JSON.stringify(messages.slice(0, 4))).toBe(prefix);
				return fauxAssistantMessage([fauxToolCall("generation_probe", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxToolCall("runtime_update", { action: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("original task continued"),
		]);
		await harness.session.prompt("Update the tool, then finish my original task");
		expect(reload).toHaveBeenCalledTimes(1);
		expect(getAssistantTexts(harness).at(-1)).toBe("original task continued");
		expect(getUserTexts(harness)).toEqual(["Update the tool, then finish my original task"]);
		expect(JSON.stringify(harness.session.messages.slice(0, 4))).toBe(prefix);
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.content.some((part) => part.type === "text" && part.text === "generation=1"),
			),
		).toBe(true);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "runtime-update" &&
						(entry.data as { status?: string }).status === "complete",
				),
		).toBe(true);
	});

	it("refuses restart without a host adapter and leaves the running runtime usable", async () => {
		const harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("runtime_update", { action: "restart", verificationTool: "read" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("restart unavailable; stopped self-update"),
		]);
		await harness.session.prompt("restart if supported");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(result)).toContain("restart adapter");
		expect(getAssistantTexts(harness).at(-1)).toBe("restart unavailable; stopped self-update");
	});
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
