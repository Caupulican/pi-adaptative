/**
 * Host-level long-session CPU profile. Skipped unless PI_PROFILE_LONG_SESSION=1; run with
 * --pool=forks so node:inspector is available (see docs/profiling-long-sessions.md, and the
 * "Profile" GitHub workflow that runs it on demand and publishes the results).
 *
 * Drives a REAL AgentSession through the faux provider with the tool mix the real session corpus
 * shows dominating long sessions (task_steps, get_goal, update_goal, read), measures every tool call
 * from its foreground_tool_start entry to its toolResult entry -- the same markers the session-log
 * census uses -- plus the host's pre-request assembly time from each request_snapshot entry, and
 * writes a V8 .cpuprofile of the whole run. The decile tables are the growth signal: a flat row
 * means no per-turn cost grows with the session; a rising row is a re-walk of history somewhere.
 *
 * PI_PROFILE_TURNS (default 300) tool turns; PI_PROFILE_DIR output directory (default profiles-node).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import inspector from "node:inspector";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../suite/harness.ts";

const TURNS = Number(process.env.PI_PROFILE_TURNS ?? 300);
const OUT_DIR = process.env.PI_PROFILE_DIR ?? join(process.cwd(), "profiles-node");
const CHUNK = 60;

function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
function deciles(values: number[]): string {
	const n = values.length;
	const out: string[] = [];
	for (let i = 0; i < 10; i++)
		out.push(
			median(values.slice(Math.floor((i * n) / 10), Math.floor(((i + 1) * n) / 10)))
				.toFixed(1)
				.padStart(7),
		);
	return out.join(" ");
}
function startProfiler(): Promise<inspector.Session> {
	const session = new inspector.Session();
	session.connect();
	return new Promise((resolve, reject) => {
		session.post("Profiler.enable", (e) => {
			if (e) return reject(e);
			session.post("Profiler.setSamplingInterval", { interval: 500 }, (e2) => {
				if (e2) return reject(e2);
				session.post("Profiler.start", (e3) => (e3 ? reject(e3) : resolve(session)));
			});
		});
	});
}
function stopProfiler(session: inspector.Session): Promise<unknown> {
	return new Promise((resolve, reject) => {
		session.post("Profiler.stop", (e, result) => {
			session.disconnect();
			e ? reject(e) : resolve((result as { profile: unknown }).profile);
		});
	});
}

describe.skipIf(process.env.PI_PROFILE_LONG_SESSION !== "1")("host long-session profile", () => {
	it("profiles the goal/task_steps tool mix over a long session", async () => {
		mkdirSync(OUT_DIR, { recursive: true });
		const report = join(OUT_DIR, "host-session-profile.txt");
		writeFileSync(report, "");
		const log = (line: string) => appendFileSync(report, `${line}\n`);
		const harness = await createHarness({ settings: { autoLearn: { enabled: false } } });
		const readTarget = join(harness.tempDir, "read-target.txt");
		writeFileSync(readTarget, "x".repeat(2_000));
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Profile the host over a long session" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Goal created."),
			]);
			await harness.session.prompt("Start.", { autoContinueGoal: false });

			const profiler = await startProfiler();
			const wallStart = performance.now();
			let turn = 0;
			while (turn < TURNS) {
				const steps = [];
				const chunkEnd = Math.min(TURNS, turn + CHUNK);
				for (; turn < chunkEnd; turn++) {
					const k = turn % 6;
					const call =
						k === 0
							? fauxToolCall("task_steps", { action: "add", content: `step ${String(turn).padStart(5, "0")}` })
							: k === 1
								? fauxToolCall("get_goal", {})
								: k === 2
									? fauxToolCall("task_steps", {
											action: "update",
											id: `step ${String(turn - 2).padStart(5, "0")}`,
											status: "completed",
										})
									: k === 3
										? fauxToolCall("task_steps", { action: "list" })
										: k === 4
											? fauxToolCall("read", { path: readTarget })
											: fauxToolCall("update_goal", { status: "active" });
					steps.push(fauxAssistantMessage([call], { stopReason: "toolUse" }));
				}
				steps.push(
					fauxAssistantMessage([fauxToolCall("task_steps", { action: "compact" })], { stopReason: "toolUse" }),
				);
				steps.push(fauxAssistantMessage(`Chunk done at ${turn}.`));
				harness.setResponses(steps);
				await harness.session.prompt(`Continue ${turn}.`, { autoContinueGoal: false });
			}
			const wallMs = performance.now() - wallStart;
			const profile = await stopProfiler(profiler);
			writeFileSync(join(OUT_DIR, "host-session.cpuprofile"), JSON.stringify(profile));

			// Per-tool latency from the session log markers, in call order.
			const entries = harness.sessionManager.getEntries();
			const starts = new Map<string, { at: number; tool: string }>();
			const byTool = new Map<string, number[]>();
			let errors = 0;
			const snapshotGaps: number[] = [];
			const byId = new Map(entries.map((e) => [e.id, e] as const));
			for (const entry of entries) {
				if (entry.type === "foreground_tool_start")
					starts.set(entry.callId, { at: Date.parse(entry.timestamp), tool: entry.toolName });
				if (entry.type === "message" && entry.message.role === "toolResult") {
					const start = starts.get(entry.message.toolCallId);
					if (start) {
						const list = byTool.get(start.tool) ?? [];
						list.push(Date.parse(entry.timestamp) - start.at);
						byTool.set(start.tool, list);
					}
					if (entry.message.isError) {
						errors++;
						log(`tool error: ${JSON.stringify(entry.message.content).slice(0, 1500)}`);
					}
				}
				if (entry.type === "request_snapshot") {
					const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
					if (parent && "timestamp" in parent)
						snapshotGaps.push(Date.parse(entry.timestamp) - Date.parse(parent.timestamp));
				}
			}
			log(`turns=${TURNS} wall=${wallMs.toFixed(0)}ms entries=${entries.length} toolErrors=${errors}`);
			log(`host pre-request ms by decile: ${deciles(snapshotGaps)}  (n=${snapshotGaps.length})`);
			for (const [tool, values] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
				log(`tool ${tool.padEnd(12)} n=${String(values.length).padStart(4)} ms by decile: ${deciles(values)}`);
			}
			expect(errors).toBe(0);
		} finally {
			await harness.cleanup();
		}
	}, 600_000);
});
