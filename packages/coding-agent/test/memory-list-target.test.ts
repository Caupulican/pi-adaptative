import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";

describe("memory list target selection", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	it("restores a user preference into standing context after restarting the provider", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-user-context-"));
		roots.push(root);
		const options = { agentDir: join(root, "agent"), cwd: root, isChildSession: false };
		const writer = new FileStoreProvider();
		await writer.initialize("writer", options);
		expect(writer.systemPromptBlock()).not.toContain("Prefer concise technical answers.");
		const result = await writer.getToolDefinitions()[0].execute(
			"preference",
			{
				action: "add",
				target: "user",
				content: "Prefer concise technical answers.",
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(result.details).toMatchObject({ success: true });
		expect(writer.systemPromptBlock()).toContain("Prefer concise technical answers.");
		await writer.shutdown();
		const reader = new FileStoreProvider();
		await reader.initialize("reader", options);
		expect(reader.systemPromptBlock()).toContain("USER.md");
		expect(reader.systemPromptBlock()).toContain("Prefer concise technical answers.");
		await reader.shutdown();
	});

	it.each(["memory", "project", "user", undefined] as const)(
		"lists only the requested %s target, or every hot file when omitted",
		async (target) => {
			const root = mkdtempSync(join(tmpdir(), "pi-memory-list-target-"));
			roots.push(root);
			const provider = new FileStoreProvider();
			await provider.initialize("list-target", { agentDir: join(root, "agent"), cwd: root, isChildSession: false });
			const tool = provider.getToolDefinitions()[0];
			const context = {} as ExtensionContext;
			for (const scope of ["memory", "project", "user"] as const) {
				const added = await tool.execute(
					"seed",
					{ action: "add", target: scope, content: `${scope} sentinel` },
					undefined,
					undefined,
					context,
				);
				expect(added.details).toMatchObject({ success: true });
			}
			const result = await tool.execute(
				"list",
				{ action: "list", ...(target ? { target } : {}) },
				undefined,
				undefined,
				context,
			);
			const selected = target ? [target] : ["memory", "project", "user"];
			expect(result.details).toMatchObject({
				success: true,
				files: selected.map((scope) => ({ target: scope, drift: false })),
			});
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			for (const scope of ["memory", "project", "user"]) {
				if (selected.includes(scope)) expect(text).toContain(`${scope} sentinel`);
				else expect(text).not.toContain(`${scope} sentinel`);
			}
		},
	);
});
