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
import { AgentBusyError } from "@caupulican/pi-agent-core/agent";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../../src/core/default-tool-surface.ts";
import { createHarness } from "../suite/harness.ts";

const TURNS = Number(process.env.PI_PROFILE_TURNS ?? 300);
const OUT_DIR = process.env.PI_PROFILE_DIR ?? join(process.cwd(), "profiles-node");
const CHUNK = 60;
/**
 * PI_PROFILE_SCENARIO selects the tool mix:
 * - `goal` (default): task_steps / get_goal / update_goal / read, the mix that dominates the real
 *   session corpus;
 * - `tools`: bash / grep / read with large outputs, so the tool-output reducers (bounding, packing,
 *   artifacts) run on every call and can be measured;
 * - `delegate`: the goal mix plus one in-process worker delegation every DELEGATE_EVERY turns, so
 *   the delegation ledger and worker bookkeeping grow with the session as they do in real use.
 */
const SCENARIO = (process.env.PI_PROFILE_SCENARIO ?? "goal") as "goal" | "tools" | "delegate";
const DELEGATE_EVERY = 30;

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
		const harness = await createHarness({
			settings: {
				autoLearn: { enabled: false },
				...(SCENARIO === "delegate" ? { workerDelegation: { enabled: true, maxConcurrent: 1 } } : {}),
			},
			// grep is not in the default tool surface; the tools scenario needs it active.
			...(SCENARIO === "tools" ? { initialActiveToolNames: [...DEFAULT_ACTIVE_TOOL_NAMES, "grep"] } : {}),
		});
		const readTarget = join(harness.tempDir, "read-target.txt");
		writeFileSync(readTarget, "x".repeat(2_000));
		// Fixtures for the tools scenario: a large file to read, and a corpus for grep with many hits.
		const largeTarget = join(harness.tempDir, "large-target.txt");
		writeFileSync(
			largeTarget,
			Array.from({ length: 1_200 }, (_, i) => `line ${i} needle-${i % 7} payload ${"y".repeat(40)}`).join("\n"),
		);
		const grepDir = join(harness.tempDir, "grep-corpus");
		mkdirSync(grepDir, { recursive: true });
		for (let file = 0; file < 12; file++) {
			writeFileSync(
				join(grepDir, `corpus-${file}.txt`),
				Array.from({ length: 300 }, (_, i) => `entry ${i} needle-${i % 5} in file ${file}`).join("\n"),
			);
		}
		const bigOutputCommand = `node -e "for (let i = 0; i < 3000; i++) console.log('row ' + i + ' ' + 'z'.repeat(60))"`;
		const smallOutputCommand = `node -e "console.log('ok')"`;
		const delegateDurations: number[] = [];
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
					// One self-contained action per turn, in the mix the real corpus shows dominating long
					// sessions. The task_steps add creates the active step; the update two turns later
					// targets "current" (the active step) rather than a numeric selector that a periodic
					// compact could archive from under it, so the scenario never fails by construction.
					const k = turn % 6;
					const call =
						SCENARIO === "tools"
							? k === 0 || k === 3
								? fauxToolCall("bash", { command: bigOutputCommand })
								: k === 1
									? fauxToolCall("grep", { pattern: "needle-3", path: grepDir, glob: "*.txt" })
									: k === 2
										? fauxToolCall("read", { path: largeTarget })
										: k === 4
											? fauxToolCall("grep", { pattern: "entry 1\\d", path: grepDir, glob: "*.txt" })
											: fauxToolCall("bash", { command: smallOutputCommand })
							: k === 0
								? fauxToolCall("task_steps", {
										action: "add",
										content: `step ${String(turn).padStart(5, "0")}`,
										status: "in_progress",
									})
								: k === 1
									? fauxToolCall("get_goal", {})
									: k === 2
										? fauxToolCall("task_steps", { action: "update", id: "current", status: "completed" })
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
				// A worker's completion handoff can hold the foreground exactly when the next scripted
				// prompt arrives. The scripted queue must stay aligned with THIS prompt, so wait the
				// handoff out (bounded) instead of queuing behind it.
				for (let attempt = 0; ; attempt++) {
					try {
						await harness.session.prompt(`Continue ${turn}.`, { autoContinueGoal: false });
						break;
					} catch (error) {
						if (!(error instanceof AgentBusyError) || attempt >= 500) throw error;
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
				}
				if (SCENARIO === "delegate") {
					// One worker per DELEGATE_EVERY turns: it reads a file and files its claim. Its wall time
					// is the `delegate` span the real corpus showed growing tenfold across a session.
					for (let delegation = 0; delegation < CHUNK / DELEGATE_EVERY; delegation++) {
						harness.setResponses([
							fauxAssistantMessage([fauxToolCall("read", { path: readTarget })], { stopReason: "toolUse" }),
							fauxAssistantMessage(`{"summary":"worker ${turn}-${delegation} done","status":"completed"}`),
						]);
						const startedAt = performance.now();
						await harness.session.runWorkerDelegationOnce({ instructions: `Inspect the target at turn ${turn}` });
						delegateDurations.push(performance.now() - startedAt);
					}
				}
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
					// PI_PROFILE_TRACE_TOOL=<name>: log every result of one tool, to see what the scripted
					// scenario actually produced around a failure.
					if (
						process.env.PI_PROFILE_TRACE_TOOL &&
						(process.env.PI_PROFILE_TRACE_TOOL === "*" || start?.tool === process.env.PI_PROFILE_TRACE_TOOL)
					) {
						log(
							`trace ${start?.tool ?? entry.message.toolName}: ${JSON.stringify(entry.message.content).slice(0, 160)}`,
						);
					}
				}
				if (entry.type === "request_snapshot") {
					const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
					if (parent && "timestamp" in parent)
						snapshotGaps.push(Date.parse(entry.timestamp) - Date.parse(parent.timestamp));
				}
			}
			log(
				`turns=${TURNS} scenario=${SCENARIO} wall=${wallMs.toFixed(0)}ms entries=${entries.length} toolErrors=${errors}`,
			);
			log(`host pre-request ms by decile: ${deciles(snapshotGaps)}  (n=${snapshotGaps.length})`);
			for (const [tool, values] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
				log(`tool ${tool.padEnd(12)} n=${String(values.length).padStart(4)} ms by decile: ${deciles(values)}`);
			}
			if (delegateDurations.length > 0) {
				log(
					`tool ${"delegate-run".padEnd(12)} n=${String(delegateDurations.length).padStart(4)} ms by decile: ${deciles(delegateDurations)}`,
				);
			}
			// A load generator, not a correctness test: a handful of scripted task-step misses across the
			// periodic compact are realistic and exercise the failure-ledger path this profile measures, so
			// the error count is reported, not asserted to zero. What must hold is that the run did real work.
			expect(entries.length).toBeGreaterThan(TURNS);
			expect(byTool.size).toBeGreaterThan(0);
		} finally {
			await harness.cleanup();
		}
	}, 600_000);
});
