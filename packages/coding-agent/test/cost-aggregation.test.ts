import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, type Usage } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Cost Aggregation (Model A): spawned/subagent usage is persisted as `spawned_usage` custom
 * entries, summed into the footer's displayed cost, de-duplicated by reportId, and exposed to
 * extensions via `pi.reportSpawnedUsage`.
 */
describe("Cost aggregation (spawned-usage roll-up)", () => {
	let tempDir: string;
	let agentDir: string;

	function usage(costTotal: number): Usage {
		return {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: costTotal / 2, output: costTotal / 2, cacheRead: 0, cacheWrite: 0, total: costTotal },
		};
	}

	const newSession = async (opts: { extensionFactories?: unknown[] } = {}) => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: opts.extensionFactories as any,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-cost-agg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("sums multiple spawned-usage reports into the rolled-up cost", async () => {
		const session = await newSession();

		expect(session.getSpawnedUsage()).toEqual({ cost: 0, reports: 0 });

		session.addSpawnedUsage(usage(0.31), { label: "subagent-a" });
		session.addSpawnedUsage(usage(0.12), { label: "subagent-b" });

		const totals = session.getSpawnedUsage();
		expect(totals.reports).toBe(2);
		expect(totals.cost).toBeCloseTo(0.43, 10);
		session.dispose();
	});

	it("persists reports as `spawned_usage` custom entries (does NOT enter LLM context)", async () => {
		const session = await newSession();
		session.addSpawnedUsage(usage(0.5), { label: "child", sourceSessionId: "sess-1", reportId: "r1" });

		const customEntries = session.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && e.customType === SPAWNED_USAGE_CUSTOM_TYPE);
		expect(customEntries).toHaveLength(1);
		// CustomEntry (type "custom") is persistence-only — not custom_message — so it never injects
		// into the model context.
		expect(session.systemPrompt).not.toContain("spawned_usage");
		session.dispose();
	});

	it("is idempotent on reportId — a duplicate report does not double-count", async () => {
		const session = await newSession();

		const firstId = session.addSpawnedUsage(usage(0.2), { reportId: "dup-key" });
		const secondId = session.addSpawnedUsage(usage(0.2), { reportId: "dup-key" });

		expect(firstId).toBeTruthy();
		expect(secondId).toBeUndefined();
		expect(session.getSpawnedUsage()).toEqual({ cost: 0.2, reports: 1 });
		session.dispose();
	});

	it("counts reports without a reportId independently (no accidental dedupe)", async () => {
		const session = await newSession();
		session.addSpawnedUsage(usage(0.1));
		session.addSpawnedUsage(usage(0.1));
		expect(session.getSpawnedUsage().reports).toBe(2);
		expect(session.getSpawnedUsage().cost).toBeCloseTo(0.2, 10);
		session.dispose();
	});

	it("getCumulativeUsage() returns a zeroed Usage for a session with no assistant turns", async () => {
		const session = await newSession();
		const cumulative = session.getCumulativeUsage();
		expect(cumulative.cost.total).toBe(0);
		expect(cumulative.input).toBe(0);
		expect(cumulative.totalTokens).toBe(0);
		session.dispose();
	});

	it("getCumulativeUsage() rolls up spawned-usage so single-hop reporting can't drop grandchildren", async () => {
		// A print-mode child that itself spawned subagents must report own + sub-usage in one
		// number. With no own assistant turns, the cumulative still includes the rolled-up children.
		const session = await newSession();
		session.addSpawnedUsage(usage(0.25), { label: "grandchild-1", reportId: "g1" });
		session.addSpawnedUsage(usage(0.15), { label: "grandchild-2", reportId: "g2" });

		const cumulative = session.getCumulativeUsage();
		expect(cumulative.cost.total).toBeCloseTo(0.4, 10);
		// Token breakdown is carried through too (each fixture report = 150 totalTokens).
		expect(cumulative.totalTokens).toBe(300);
		session.dispose();
	});

	it("exposes pi.reportSpawnedUsage to extensions, routing to the session roll-up", async () => {
		const reportId = "ext-report-1";
		const session = await newSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("session_start", () => {
						pi.reportSpawnedUsage(usage(0.77), { label: "spawned-by-ext", reportId });
					});
				},
			],
		});

		const totals = session.getSpawnedUsage();
		expect(totals.reports).toBe(1);
		expect(totals.cost).toBeCloseTo(0.77, 10);
		session.dispose();
	});
});
