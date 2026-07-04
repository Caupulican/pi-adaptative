import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel, type Usage } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "../src/core/agent-session.ts";
import {
	aggregateCumulativeUsageFromSessionEntries,
	reportCompletedAutoLearnUsageHelper,
} from "../src/core/cost/session-usage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
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
		if (opts.extensionFactories?.length) {
			settingsManager.addInlineResourceProfileDefinitions({
				"with-extension": { extensions: { allow: ["<inline:1>"] } },
			});
			settingsManager.setRuntimeResourceProfiles(["with-extension"]);
		}
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

	describe("aggregateCumulativeUsageFromSessionEntries", () => {
		it("sums assistant usage", () => {
			const entries: SessionEntry[] = [
				{
					type: "message",
					id: "1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
						usage: usage(0.12),
						timestamp: Date.now(),
					},
				} as unknown as SessionEntry,
				{
					type: "message",
					id: "2",
					parentId: "1",
					timestamp: new Date().toISOString(),
					message: {
						role: "user",
						content: [{ type: "text", text: "hi" }],
						timestamp: Date.now(),
					},
				} as unknown as SessionEntry,
				{
					type: "message",
					id: "3",
					parentId: "2",
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "there" }],
						usage: usage(0.08),
						timestamp: Date.now(),
					},
				} as unknown as SessionEntry,
			];

			const result = aggregateCumulativeUsageFromSessionEntries(entries);
			expect(result.cost.total).toBeCloseTo(0.2, 10);
			expect(result.totalTokens).toBe(300);
		});

		it("rolls up spawned usage", () => {
			const entries: SessionEntry[] = [
				{
					type: "message",
					id: "1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
						usage: usage(0.1),
						timestamp: Date.now(),
					},
				} as unknown as SessionEntry,
				{
					type: "custom",
					id: "2",
					parentId: "1",
					timestamp: new Date().toISOString(),
					customType: SPAWNED_USAGE_CUSTOM_TYPE,
					data: {
						usage: usage(0.15),
						reportId: "spawn-1",
					},
				},
			];

			const result = aggregateCumulativeUsageFromSessionEntries(entries);
			expect(result.cost.total).toBeCloseTo(0.25, 10);
			expect(result.totalTokens).toBe(300);
		});

		it("ignores malformed spawned usage", () => {
			const entries: SessionEntry[] = [
				{
					type: "custom",
					id: "1",
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: SPAWNED_USAGE_CUSTOM_TYPE,
					data: {
						// missing usage
						reportId: "spawn-1",
					},
				} as unknown as SessionEntry,
				{
					type: "custom",
					id: "2",
					parentId: "1",
					timestamp: new Date().toISOString(),
					customType: SPAWNED_USAGE_CUSTOM_TYPE,
					data: {
						usage: {
							input: "invalid", // invalid type
							cost: { total: 0.15 },
						},
					},
				} as unknown as SessionEntry,
				{
					type: "custom",
					id: "3",
					parentId: "2",
					timestamp: new Date().toISOString(),
					customType: SPAWNED_USAGE_CUSTOM_TYPE,
				} as SessionEntry,
			];

			const result = aggregateCumulativeUsageFromSessionEntries(entries);
			expect(result.cost.total).toBe(0);
			expect(result.totalTokens).toBe(0);
		});
	});

	describe("Auto Learn cleanup integration", () => {
		it("Auto Learn cleanup reports child usage before removing artifacts", async () => {
			const session = await newSession();
			const childSessionId = "child-session-id-123";
			const runId = "run-id-abc";
			const sessionDir = join(tempDir, "sessions", runId);
			mkdirSync(sessionDir, { recursive: true });

			const childSessionFile = join(sessionDir, `2026-06-29T21-30-00_500_${childSessionId}.jsonl`);

			// Write child session file content
			const header = { type: "session", id: childSessionId, timestamp: new Date().toISOString(), cwd: tempDir };
			const assistantEntry = {
				type: "message",
				id: "msg-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "completed reflection" }],
					usage: usage(0.18),
					timestamp: Date.now(),
				},
			};
			const spawnedEntry = {
				type: "custom",
				id: "msg-2",
				parentId: "msg-1",
				timestamp: new Date().toISOString(),
				customType: SPAWNED_USAGE_CUSTOM_TYPE,
				data: {
					usage: usage(0.07),
					reportId: "sub-1",
				},
			};

			const fileContent = `${[
				JSON.stringify(header),
				JSON.stringify(assistantEntry),
				JSON.stringify(spawnedEntry),
			].join("\n")}\n`;

			writeFileSync(childSessionFile, fileContent, "utf-8");

			const logs: string[] = [];
			const appendLog = (_path: string, msg: string) => {
				logs.push(msg);
			};

			reportCompletedAutoLearnUsageHelper({
				runId,
				sessionDir,
				sessionId: childSessionId,
				logPath: "fake.log",
				parentSession: session,
				appendLog,
			});

			const spawnedUsage = session.getSpawnedUsage();
			expect(spawnedUsage.reports).toBe(1);
			expect(spawnedUsage.cost).toBeCloseTo(0.25, 10);

			expect(logs).toContain(`Auto Learn usage reported: ${childSessionId}.`);
			session.dispose();
		});

		it("Auto Learn cleanup report is idempotent by reportId", async () => {
			const session = await newSession();
			const childSessionId = "child-session-id-456";
			const runId = "run-id-def";
			const sessionDir = join(tempDir, "sessions", runId);
			mkdirSync(sessionDir, { recursive: true });

			const childSessionFile = join(sessionDir, `2026-06-29T21-30-00_500_${childSessionId}.jsonl`);

			const header = { type: "session", id: childSessionId, timestamp: new Date().toISOString(), cwd: tempDir };
			const assistantEntry = {
				type: "message",
				id: "msg-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "completed learning" }],
					usage: usage(0.4),
					timestamp: Date.now(),
				},
			};

			const fileContent = `${[JSON.stringify(header), JSON.stringify(assistantEntry)].join("\n")}\n`;

			writeFileSync(childSessionFile, fileContent, "utf-8");

			reportCompletedAutoLearnUsageHelper({
				runId,
				sessionDir,
				sessionId: childSessionId,
				logPath: "fake.log",
				parentSession: session,
			});

			// Call twice to check idempotence
			reportCompletedAutoLearnUsageHelper({
				runId,
				sessionDir,
				sessionId: childSessionId,
				logPath: "fake.log",
				parentSession: session,
			});

			const spawnedUsage = session.getSpawnedUsage();
			expect(spawnedUsage.reports).toBe(1);
			expect(spawnedUsage.cost).toBeCloseTo(0.4, 10);
			session.dispose();
		});

		it("drives cleanupCompletedAutoLearnRun ordering: reports child usage, then deletes artifacts", async () => {
			const session = await newSession();
			const childSessionId = "child-session-id-789";
			const runId = "run-id-ghi";
			const sessionDir = join(tempDir, "sessions", runId);
			mkdirSync(sessionDir, { recursive: true });

			const childSessionFile = join(sessionDir, `2026-06-29T21-30-00_500_${childSessionId}.jsonl`);
			const logPath = join(sessionDir, "fake.log");
			const promptPath = join(sessionDir, "fake.prompt.md");
			writeFileSync(
				childSessionFile,
				`{"type":"session","id":"${childSessionId}"}\n{"type":"message","message":{"role":"assistant","usage":{"input":10,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":30,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}},"timestamp":123}}`,
				"utf-8",
			);
			writeFileSync(logPath, "some log", "utf-8");
			writeFileSync(promptPath, "some prompt", "utf-8");

			const reportSequence: string[] = [];

			// Mimic cleanupCompletedAutoLearnRun logic
			// 1. Report usage
			reportCompletedAutoLearnUsageHelper({
				runId,
				sessionDir,
				sessionId: childSessionId,
				logPath,
				parentSession: {
					addSpawnedUsage: (usage: Usage, opts: { label: string; sourceSessionId: string; reportId: string }) => {
						reportSequence.push("reported");
						return session.addSpawnedUsage(usage, opts);
					},
				},
			});

			// 2. Delete files
			const artifactPaths = [promptPath, logPath, sessionDir];
			for (const p of artifactPaths) {
				if (existsSync(p)) {
					rmSync(p, { recursive: true, force: true });
					reportSequence.push(`deleted:${basename(p)}`);
				}
			}

			expect(reportSequence).toEqual([
				"reported",
				"deleted:fake.prompt.md",
				"deleted:fake.log",
				"deleted:run-id-ghi", // sessionDir name is runId
			]);
			expect(session.getSpawnedUsage().cost).toBeCloseTo(0.3, 10);
			session.dispose();
		});
	});
});
