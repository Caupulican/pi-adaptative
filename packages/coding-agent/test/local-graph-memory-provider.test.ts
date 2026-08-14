import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createLocalGraphMemoryProvider,
	LOCAL_GRAPH_PROVIDER_ID,
	resolveLocalGraphPath,
} from "../src/core/context/local-graph-memory-provider.ts";

describe("local graph memory provider", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("is absent when no local graph exists", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-local-graph-none-"));
		roots.push(root);
		expect(resolveLocalGraphPath(root, join(root, "agent"))).toBeUndefined();
		expect(createLocalGraphMemoryProvider({ cwd: root, agentDir: join(root, "agent") })).toBeUndefined();
	});

	it("retrieves local graph nodes without a human prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-local-graph-hit-"));
		roots.push(root);
		const graphDir = join(root, "graphify-out");
		mkdirSync(graphDir, { recursive: true });
		writeFileSync(
			join(graphDir, "graph.json"),
			JSON.stringify({
				nodes: [
					{ id: "WorkerHandoff", label: "Worker terminal handoff", text: "Parent wakes on lane terminal" },
					{ id: "Unrelated", label: "Palette tokens", text: "Color ramp" },
				],
			}),
		);

		const provider = createLocalGraphMemoryProvider({ cwd: root, agentDir: join(root, "agent") });
		expect(provider?.id).toBe(LOCAL_GRAPH_PROVIDER_ID);
		const hits = await provider!.search({ query: "worker terminal handoff", maxResults: 4 });
		expect(hits[0]?.item.id).toBe("WorkerHandoff");
		expect(hits[0]?.item.summary).toContain("Parent wakes");
	});
});
