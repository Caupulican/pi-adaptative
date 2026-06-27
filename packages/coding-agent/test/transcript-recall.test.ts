import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptRecallProvider } from "../src/core/memory/providers/transcript-recall.ts";
import { getDefaultSessionDir } from "../src/core/session-manager.ts";

/**
 * R3 host integration: TranscriptRecallProvider indexes past-session JSONL transcripts and answers
 * prefetch() with a relevant <memory_context> page — excluding the current session, returning nothing
 * for irrelevant queries.
 */
describe("TranscriptRecallProvider (cross-session recall)", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let sessionDir: string;

	const writeSession = (id: string, turns: Array<{ role: "user" | "assistant"; text: string }>) => {
		const header = { type: "session", id, timestamp: "2026-06-01T00:00:00.000Z", cwd, version: 2 };
		const lines = [JSON.stringify(header)];
		let i = 0;
		for (const turn of turns) {
			lines.push(
				JSON.stringify({
					type: "message",
					id: `${id}-m${i}`,
					parentId: i === 0 ? id : `${id}-m${i - 1}`,
					timestamp: "2026-06-01T00:00:00.000Z",
					message: { role: turn.role, content: [{ type: "text", text: turn.text }] },
				}),
			);
			i++;
		}
		writeFileSync(join(sessionDir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-recall-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "cwd");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		sessionDir = getDefaultSessionDir(cwd, agentDir); // creates + returns the resolved dir
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	const newProvider = async (currentSessionId: string) => {
		const provider = new TranscriptRecallProvider();
		await provider.initialize(currentSessionId, { agentDir, cwd, isChildSession: false });
		return provider;
	};

	it("surfaces a relevant snippet from a past session", async () => {
		writeSession("past-1", [
			{ role: "user", text: "How do I configure the kubernetes deployment pipeline for staging?" },
			{ role: "assistant", text: "Use the helm chart in infra/ and set the staging values file." },
		]);

		const provider = await newProvider("current-session");
		const page = await provider.prefetch("kubernetes deployment pipeline staging config");

		expect(page).toContain("<memory_context");
		expect(page.toLowerCase()).toContain("kubernetes");
		await provider.shutdown();
	});

	it("returns nothing for an irrelevant query", async () => {
		writeSession("past-1", [{ role: "user", text: "How do I configure the kubernetes deployment pipeline?" }]);

		const provider = await newProvider("current-session");
		const page = await provider.prefetch("unrelated quantum banana xylophone marmalade");

		expect(page).toBe("");
		await provider.shutdown();
	});

	it("excludes the current session from recall", async () => {
		// Only the CURRENT session contains the unique term — recall must not surface it.
		writeSession("current-session", [{ role: "user", text: "zephyrhydra unique token only here" }]);
		writeSession("past-1", [{ role: "user", text: "totally different content about databases" }]);

		const provider = await newProvider("current-session");
		const page = await provider.prefetch("zephyrhydra unique token");

		expect(page).toBe("");
		await provider.shutdown();
	});

	it("recalls a relevant passage from a long, high-vocabulary session (containment, not Jaccard)", async () => {
		// Regression: pure Jaccard misses here because the doc's large unique vocabulary dominates the
		// union. Containment scoring (fraction of query terms present) must still surface the passage.
		const filler = Array.from({ length: 250 }, (_, i) => `distinctword${i}topic`).join(" ");
		writeSession("past-long", [
			{
				role: "user",
				text: `${filler} To deploy kubernetes configure the helm chart and set the staging values file.`,
			},
		]);

		const provider = await newProvider("current-session");
		const page = await provider.prefetch("how do I deploy kubernetes with the helm chart staging values");

		expect(page).toContain("<memory_context");
		expect(page.toLowerCase()).toContain("kubernetes");
		await provider.shutdown();
	});

	it("returns nothing when there is no corpus", async () => {
		const provider = await newProvider("current-session");
		expect(await provider.prefetch("anything at all here")).toBe("");
		await provider.shutdown();
	});
});
