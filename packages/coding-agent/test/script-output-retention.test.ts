import { describe, expect, it, vi } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createRunToolkitScriptToolDefinition } from "../src/core/tools/run-toolkit-script.ts";

describe("script result survives optional artifact failure", () => {
	it.each(["write", "reference", "control"].flatMap((fault) =>
		["success", "negative", "timeout"].map((operation) => ({ fault, operation })),
	))("executes once and keeps its real status: $fault / $operation", async ({ fault, operation }) => {
		const store = createInMemoryArtifactStore();
		if (fault === "write") vi.spyOn(store, "write").mockImplementation(() => { throw new Error("private storage error"); });
		if (fault === "reference") vi.spyOn(store, "addReference").mockImplementation(() => { throw undefined; });
		const exitCode = operation === "success" ? 0 : operation === "negative" ? 1 : null;
		const execute = vi.fn(async () => ({
			exitCode, timedOut: operation === "timeout", durationMs: 10,
			stdout: Array.from({ length: 5000 }, (_, index) => `committed line ${index}`).join("\n"), stderr: "terminal diagnostic",
		}));
		const tool = createRunToolkitScriptToolDefinition({
			getScripts: () => [{ name: "fixture", description: "Synthetic fixture", path: "fixture.sh", runner: "bash" }],
			execute, artifactStore: store,
		});
		const result = await tool.execute("fixture-call", { script: "fixture" }, undefined, undefined, {} as ExtensionContext);
		expect(execute).toHaveBeenCalledOnce();
		expect(result.isError === true).toBe(operation !== "success");
		expect(result.details).toMatchObject({ outcome: operation === "success" ? "executed" : "failed", exitCode, durationMs: 10 });
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		expect(text).toContain("committed line 0");
		expect(text).toContain("terminal diagnostic");
		expect(text).not.toContain("private storage error");
		if (fault !== "control") {
			expect(text).toContain("Full output unavailable");
			expect(result.details).not.toHaveProperty("artifactId");
		} else {
			expect(text).toContain("Full output: artifact tool-output:");
		}
	});
});
