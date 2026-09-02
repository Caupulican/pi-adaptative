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
 * It also samples memory, disk, CPU and child-process pressure at every turn boundary (see
 * `samplePressure` / the `message_end` subscription below) and writes those to
 * `host-session-pressure.txt` / `.json`, alongside the existing `host-session-profile.txt`.
 *
 * PI_PROFILE_TURNS (default 300) tool turns; PI_PROFILE_DIR output directory (default profiles-node).
 */
import childProcess from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import inspector from "node:inspector";
import { basename, join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { AgentBusyError } from "@caupulican/pi-agent-core/agent";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import type { FauxRequestEvent } from "@caupulican/pi-ai/faux";
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
interface PressureSample {
	turn: number;
	rss: number;
	heapUsed: number;
	heapTotal: number;
	external: number;
	userCPUTime: number;
	systemCPUTime: number;
	fsRead: number;
	fsWrite: number;
	maxRSS: number;
	voluntaryContextSwitches: number;
	involuntaryContextSwitches: number;
}
interface SpawnRecord {
	turn: number;
	command: string;
}
function samplePressure(turn: number): PressureSample {
	const mem = process.memoryUsage();
	const ru = process.resourceUsage();
	return {
		turn,
		rss: mem.rss,
		heapUsed: mem.heapUsed,
		heapTotal: mem.heapTotal,
		external: mem.external,
		userCPUTime: ru.userCPUTime,
		systemCPUTime: ru.systemCPUTime,
		fsRead: ru.fsRead,
		fsWrite: ru.fsWrite,
		maxRSS: ru.maxRSS,
		voluntaryContextSwitches: ru.voluntaryContextSwitches,
		involuntaryContextSwitches: ru.involuntaryContextSwitches,
	};
}
function commandBasename(value: string | null | undefined): string {
	if (!value) return "unknown";
	const first = value.trim().split(/\s+/)[0] ?? value;
	return basename(first) || first;
}
/**
 * Renders the pressure decile table plus totals. `samples[0]` is the pre-run baseline; `samples[i]`
 * (i >= 1) is the state right after turn `i` completed, so the delta over any range of turns is a
 * plain difference of the cumulative counters at its start and end -- no need to store per-turn
 * deltas separately.
 */
function renderPressureReport(samples: PressureSample[], spawns: SpawnRecord[]): string {
	const mb = (bytes: number) => bytes / (1024 * 1024);
	const perTurn = samples.slice(1);
	const lines: string[] = [];
	lines.push(`pressure samples: turns=${perTurn.length} (plus 1 pre-run baseline)`);
	lines.push("decile   rssMB   heapMB  cpuMs/turn  fsRead/turn  fsWrite/turn  ctxSw/turn  spawns");
	const n = perTurn.length;
	for (let i = 0; i < 10; i++) {
		const start = Math.floor((i * n) / 10);
		const end = Math.floor(((i + 1) * n) / 10);
		const group = perTurn.slice(start, end);
		const label = String(i + 1).padStart(6);
		if (group.length === 0) {
			lines.push(`${label}       -       -           -            -             -           -       0`);
			continue;
		}
		const before = samples[start]!;
		const after = samples[end]!;
		const cpuMsPerTurn =
			(after.userCPUTime - before.userCPUTime + (after.systemCPUTime - before.systemCPUTime)) / 1000 / group.length;
		const fsReadPerTurn = (after.fsRead - before.fsRead) / group.length;
		const fsWritePerTurn = (after.fsWrite - before.fsWrite) / group.length;
		const ctxPerTurn =
			(after.voluntaryContextSwitches -
				before.voluntaryContextSwitches +
				(after.involuntaryContextSwitches - before.involuntaryContextSwitches)) /
			group.length;
		const medianRssMb = median(group.map((s) => mb(s.rss)));
		const medianHeapMb = median(group.map((s) => mb(s.heapUsed)));
		const turnRangeStart = start + 1;
		const turnRangeEnd = end;
		const spawnCount = spawns.filter((s) => s.turn >= turnRangeStart && s.turn <= turnRangeEnd).length;
		lines.push(
			`${label} ${medianRssMb.toFixed(1).padStart(7)} ${medianHeapMb.toFixed(1).padStart(7)} ${cpuMsPerTurn.toFixed(2).padStart(11)} ${fsReadPerTurn.toFixed(2).padStart(12)} ${fsWritePerTurn.toFixed(2).padStart(13)} ${ctxPerTurn.toFixed(2).padStart(11)} ${String(spawnCount).padStart(7)}`,
		);
	}
	const baseline0 = samples[0]!;
	const last = samples[samples.length - 1]!;
	const peakRssMb = Math.max(...samples.map((s) => mb(s.rss)));
	const peakHeapMb = Math.max(...samples.map((s) => mb(s.heapUsed)));
	const totalCpuMs =
		(last.userCPUTime - baseline0.userCPUTime + (last.systemCPUTime - baseline0.systemCPUTime)) / 1000;
	const totalFsRead = last.fsRead - baseline0.fsRead;
	const totalFsWrite = last.fsWrite - baseline0.fsWrite;
	lines.push("");
	lines.push(
		`totals: peak rss=${peakRssMb.toFixed(1)}MB peak heap=${peakHeapMb.toFixed(1)}MB total cpu=${totalCpuMs.toFixed(1)}ms total fsRead=${totalFsRead} total fsWrite=${totalFsWrite} total spawns=${spawns.length}`,
	);
	const byCommand = new Map<string, number>();
	for (const spawn of spawns) byCommand.set(spawn.command, (byCommand.get(spawn.command) ?? 0) + 1);
	const top5 = [...byCommand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
	lines.push(
		top5.length > 0
			? `top spawned commands: ${top5.map(([command, count]) => `${command}=${count}`).join(", ")}`
			: "top spawned commands: (none spawned)",
	);
	return lines.join("\n");
}
/**
 * Per session, every request after the first is either an append (the previous request's messages
 * are a byte prefix of it, so the diverging message is at or past the previous end) or a rewrite
 * (something inside the previously sent messages changed). Rewrites are grouped by where they hit,
 * counted from the previous request's end, and by the head of the message that changed.
 */
function renderCacheReport(events: FauxRequestEvent[]): string {
	const bySession = new Map<string, FauxRequestEvent[]>();
	for (const event of events) {
		const key = event.sessionId ?? "(no session)";
		bySession.set(key, [...(bySession.get(key) ?? []), event]);
	}
	const main = [...bySession.values()].sort((a, b) => b.length - a.length)[0] ?? [];
	const reuse: number[] = [];
	let appends = 0;
	let rewrites = 0;
	const rewriteKinds = new Map<string, number>();
	for (let index = 1; index < main.length; index++) {
		const event = main[index]!;
		const previous = main[index - 1]!;
		if (event.firstRequest) continue;
		reuse.push(event.promptChars > 0 ? event.cachedChars / event.promptChars : 1);
		if (event.divergedAt === undefined || event.divergedAt >= previous.messageCount) {
			appends += 1;
			continue;
		}
		rewrites += 1;
		const offset = event.divergedAt - previous.messageCount;
		const head = (event.divergedText ?? "").replace(/\s+/g, " ").replace(/\d+/g, "#").slice(0, 60);
		const was = (event.previousDivergedText ?? "(nothing)").replace(/\s+/g, " ").replace(/\d+/g, "#").slice(0, 60);
		const kind = `${event.divergedRole ?? "?"} at previous-end${offset} :: now ${head} :: was ${was}`;
		rewriteKinds.set(kind, (rewriteKinds.get(kind) ?? 0) + 1);
	}
	const measured = appends + rewrites;
	const p50 = reuse.length > 0 ? median(reuse) : 1;
	const high = reuse.length > 0 ? reuse.filter((value) => value >= 0.9).length / reuse.length : 1;
	// The contract gate (PI_PROFILE_GATE=1, run in CI on a short session): every request is a
	// byte-append of the previous one except the packs and summaries the harness makes on purpose.
	// A floor that only moves up; a regression here is a cache invalidation the census would pay for.
	if (process.env.PI_PROFILE_GATE === "1") {
		expect(p50).toBeGreaterThanOrEqual(0.98);
		expect(measured > 0 ? appends / measured : 1).toBeGreaterThanOrEqual(0.95);
	}
	const lines = [
		`cache: requests=${main.length} p50 reuse=${p50.toFixed(2)} share>=0.9=${high.toFixed(2)} appends=${appends}/${measured} rewrites=${rewrites}/${measured}`,
		`reuse by decile (median cachedChars/promptChars): ${deciles(reuse)}`,
		"top rewrite points (role at offset from the previous request's last message :: what is there now :: what was there):",
		...[...rewriteKinds.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([kind, count]) => `  ${String(count).padStart(5)}  ${kind}`),
	];
	if (rewriteKinds.size === 0) lines.push("  (none: every request appended to the previous one)");
	return lines.join("\n");
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
		const requestEvents: FauxRequestEvent[] = [];
		const harness = await createHarness({
			fauxProvider: { onRequest: (event) => requestEvents.push(event) },
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

		// Child-process pressure: how many processes the scenario spawns, tagged with the turn that
		// spawned them. All the project's own callers (bash/grep/git tools) import `spawn` etc. as a
		// named ESM binding resolved once at load time, so reassigning `childProcess.spawn` here is a
		// no-op for them (verified empirically -- a monkeypatched property is never seen by a caller
		// holding its own copy of the original function). Node's `diagnostics_channel` "child_process"
		// channel is the mechanism that actually observes process creation regardless of how the
		// caller obtained its reference: it fires for spawn/exec/execFile/fork alike (fork spawns
		// internally). `spawnSync`/`execFileSync` publish nothing on that channel -- Node only
		// instruments the async ChildProcess constructor -- so those two are additionally wrapped by
		// reassigning the module property, which still catches any dependency that reaches them via a
		// live CJS `require("child_process").spawnSync(...)` property lookup, even though it cannot
		// catch this project's own ESM-bound named imports.
		const spawnRecords: SpawnRecord[] = [];
		let turnsCompleted = 0;
		const childProcessChannel = diagnosticsChannel.channel("child_process");
		const onChildProcessSpawn = (message: unknown) => {
			const proc = (message as { process?: { spawnfile?: string | null; spawnargs?: string[] } } | undefined)
				?.process;
			// The channel publishes before the ChildProcess's spawnfile/spawnargs are populated
			// (verified empirically); defer the read one tick so the command is actually resolvable.
			// The turn is captured now, synchronously, since it belongs to the tool call in flight.
			const turnAtSpawn = turnsCompleted + 1;
			setImmediate(() => {
				const raw = proc?.spawnfile || proc?.spawnargs?.[0] || null;
				spawnRecords.push({ turn: turnAtSpawn, command: commandBasename(raw) });
			});
		};
		childProcessChannel.subscribe(onChildProcessSpawn);
		const originalSpawnSync = childProcess.spawnSync;
		const originalExecFileSync = childProcess.execFileSync;
		childProcess.spawnSync = ((...args: Parameters<typeof originalSpawnSync>) => {
			spawnRecords.push({ turn: turnsCompleted + 1, command: commandBasename(args[0] as string) });
			return originalSpawnSync(...args);
		}) as typeof childProcess.spawnSync;
		childProcess.execFileSync = ((...args: Parameters<typeof originalExecFileSync>) => {
			spawnRecords.push({ turn: turnsCompleted + 1, command: commandBasename(args[0] as string) });
			return originalExecFileSync(...args);
		}) as typeof childProcess.execFileSync;

		// Memory/CPU/disk pressure, sampled at every turn boundary: `message_end` fires synchronously
		// as each message finalizes, and a `toolResult` message marks the end of exactly one tool
		// turn -- the same unit the existing per-tool decile tables use.
		const pressureSamples: PressureSample[] = [samplePressure(0)];
		const unsubscribePressure = harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				turnsCompleted++;
				pressureSamples.push(samplePressure(turnsCompleted));
			}
		});
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
			// The contract gate: per-request host work must not grow with history. The last decile's
			// median may not exceed twice the first decile's (both floored at one millisecond so a
			// fast machine cannot fail on timer granularity).
			if (process.env.PI_PROFILE_GATE === "1" && snapshotGaps.length >= 100) {
				const slice = Math.floor(snapshotGaps.length / 10);
				const firstDecile = median(snapshotGaps.slice(0, slice));
				const lastDecile = median(snapshotGaps.slice(-slice));
				expect(Math.max(1, lastDecile)).toBeLessThanOrEqual(2 * Math.max(1, firstDecile));
			}
			for (const [tool, values] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
				log(`tool ${tool.padEnd(12)} n=${String(values.length).padStart(4)} ms by decile: ${deciles(values)}`);
			}
			if (delegateDurations.length > 0) {
				log(
					`tool ${"delegate-run".padEnd(12)} n=${String(delegateDurations.length).padStart(4)} ms by decile: ${deciles(delegateDurations)}`,
				);
			}

			// Memory/disk/CPU/process pressure: a separate report and raw-sample dump, alongside the
			// existing timing report above. Never gates the run -- see docs/profiling-long-sessions.md.
			writeFileSync(
				join(OUT_DIR, "host-session-pressure.json"),
				JSON.stringify({ samples: pressureSamples, spawns: spawnRecords }, null, 2),
			);
			const pressureLines = [
				`turns=${TURNS} scenario=${SCENARIO}`,
				renderPressureReport(pressureSamples, spawnRecords),
			];
			if (typeof global.gc === "function") {
				global.gc();
				const postGcHeapMb = process.memoryUsage().heapUsed / (1024 * 1024);
				pressureLines.push(`post-GC heapUsed: ${postGcHeapMb.toFixed(1)}MB`);
			} else {
				pressureLines.push("post-GC heapUsed: unavailable (run with NODE_OPTIONS=--expose-gc)");
			}
			writeFileSync(join(OUT_DIR, "host-session-pressure.txt"), `${pressureLines.join("\n")}\n`);
			// PI_PROFILE_HEAP_SNAPSHOT=1: what the heap holds at the end of the run, for
			// scripts/analyze-heapsnapshot.mjs to rank by constructor and by string shape.
			if (process.env.PI_PROFILE_HEAP_SNAPSHOT === "1") {
				if (typeof global.gc === "function") global.gc();
				writeHeapSnapshot(join(OUT_DIR, "host-session.heapsnapshot"));
			}

			// Prompt-cache reuse as the faux provider's byte-prefix cache saw every request: what the
			// owner pays for is every request that is not an append of the previous one.
			const cacheReport = renderCacheReport(requestEvents);
			writeFileSync(
				join(OUT_DIR, "host-session-cache.txt"),
				`turns=${TURNS} scenario=${SCENARIO}\n${cacheReport}\n`,
			);
			log(cacheReport.split("\n")[0] ?? "");

			// A load generator, not a correctness test: a handful of scripted task-step misses across the
			// periodic compact are realistic and exercise the failure-ledger path this profile measures, so
			// the error count is reported, not asserted to zero. What must hold is that the run did real work.
			expect(entries.length).toBeGreaterThan(TURNS);
			expect(byTool.size).toBeGreaterThan(0);
		} finally {
			unsubscribePressure();
			childProcessChannel.unsubscribe(onChildProcessSpawn);
			childProcess.spawnSync = originalSpawnSync;
			childProcess.execFileSync = originalExecFileSync;
			await harness.cleanup();
		}
	}, 600_000);
});
