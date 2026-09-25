/**
 * CI hang evidence (enabled by PI_CI_HANG_DIAGNOSTICS=1 on the Windows test steps).
 *
 * Windows runners intermittently stall a test for 30-70s where the host never does, so the cause
 * has to be read on the runner. A test still running shortly before its timeout prints what this
 * worker is waiting on (active libuv resources) and the processes that could hold it: this worker's
 * descendants, plus every shell, interpreter and git process on the machine with its parent, so an
 * orphan still holding a pipe shows up even after its parent exited. Output is bounded stderr.
 */
import { createHook } from "node:async_hooks";
import { execFile } from "node:child_process";
import { afterEach, beforeEach } from "vitest";

const LEAD_MS = 5_000;
const WATCHED_NAMES =
	/^(?:bash|sh|dash|python\d*(?:\.\d+)?|pythonw?|uv|node|git|git-remote-https|powershell|pwsh|cmd|taskkill)\.exe$/iu;
const MAX_ROWS = 60;
const MAX_PENDING_FS = 6;

/**
 * Where each in-flight filesystem request was made: a stall on a pending `FSReqPromise` otherwise
 * names no file and no caller. Entries leave the map when the request completes.
 */
const pendingFs = new Map<number, { type: string; at: number; stack: string }>();
createHook({
	init(asyncId, type) {
		if (type !== "FSREQPROMISE" && type !== "FSREQCALLBACK") return;
		const stack = (new Error().stack ?? "")
			.split("\n")
			.slice(2)
			.filter((line) => !line.includes("node:internal") && !line.includes("ci-hang-diagnostics"))
			.slice(0, 8)
			.join(" <- ");
		pendingFs.set(asyncId, { type, at: Date.now(), stack });
	},
	destroy(asyncId) {
		pendingFs.delete(asyncId);
	},
	promiseResolve(asyncId) {
		pendingFs.delete(asyncId);
	},
}).enable();

interface ProcessRow {
	ProcessId: number;
	ParentProcessId: number;
	Name: string;
	CommandLine: string | null;
	CreationDate: string | null;
}

function listProcesses(): Promise<{ rows: ProcessRow[]; error?: string }> {
	const script =
		"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='CreationDate';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress";
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ timeout: 40_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout) => {
				if (error) return resolve({ rows: [], error: error.message.slice(0, 200) });
				try {
					const parsed = JSON.parse(stdout) as ProcessRow | ProcessRow[];
					resolve({ rows: Array.isArray(parsed) ? parsed : [parsed] });
				} catch (parseError) {
					resolve({ rows: [], error: `unparsable listing: ${String(parseError).slice(0, 200)}` });
				}
			},
		);
	});
}

/** What is consuming the runner: per-process CPU seconds over a 1.5 s window, overall load, free memory. */
function sampleLoad(): Promise<string> {
	const script = [
		"$before = @{}; Get-Process | ForEach-Object { $before[$_.Id] = [double]$_.CPU }",
		"Start-Sleep -Milliseconds 1500",
		"$load = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average",
		"$freeMb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)",
		"$top = Get-Process | ForEach-Object { [pscustomobject]@{ Id = $_.Id; Name = $_.Name; Cpu = [math]::Round([double]$_.CPU - [double]$before[$_.Id], 2); Mb = [math]::Round($_.WorkingSet64 / 1MB) } } | Sort-Object Cpu -Descending | Select-Object -First 10",
		"@{ load = $load; freeMb = $freeMb; top = @($top) } | ConvertTo-Json -Compress -Depth 3",
	].join("; ");
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ timeout: 40_000, maxBuffer: 1024 * 1024, windowsHide: true },
			(error, stdout) => {
				if (error) return resolve(`load sample failed: ${error.message.slice(0, 200)}`);
				try {
					const sample = JSON.parse(stdout) as {
						load: number;
						freeMb: number;
						top: Array<{ Id: number; Name: string; Cpu: number; Mb: number }>;
					};
					const busiest = sample.top.map((row) => `${row.Name}(${row.Id}) ${row.Cpu}s ${row.Mb}MB`).join(", ");
					resolve(`cpu load ${sample.load}%, free memory ${sample.freeMb} MB; busiest over 1.5 s: ${busiest}`);
				} catch (parseError) {
					resolve(`load sample unparsable: ${String(parseError).slice(0, 200)}`);
				}
			},
		);
	});
}

async function report(testName: string, startedAt: number): Promise<void> {
	const resources = process.getActiveResourcesInfo().reduce<Record<string, number>>((counts, name) => {
		counts[name] = (counts[name] ?? 0) + 1;
		return counts;
	}, {});
	const now = Date.now();
	const oldestFs = [...pendingFs.values()]
		.sort((a, b) => a.at - b.at)
		.slice(0, MAX_PENDING_FS)
		.map((entry) => `  ${entry.type} pending ${now - entry.at}ms: ${entry.stack.slice(0, 700)}`);
	const [listing, load] = await Promise.all([listProcesses(), sampleLoad()]);
	const rows = listing.rows;
	const byParent = new Map<number, ProcessRow[]>();
	for (const row of rows) byParent.set(row.ParentProcessId, [...(byParent.get(row.ParentProcessId) ?? []), row]);
	const descendants = new Set<number>();
	const walk = (pid: number) => {
		for (const child of byParent.get(pid) ?? []) {
			if (descendants.has(child.ProcessId)) continue;
			descendants.add(child.ProcessId);
			walk(child.ProcessId);
		}
	};
	walk(process.pid);
	const alive = new Set(rows.map((row) => row.ProcessId));
	const relation = (row: ProcessRow): [number, string] =>
		descendants.has(row.ProcessId)
			? [0, "descendant"]
			: alive.has(row.ParentProcessId)
				? [2, `parent ${row.ParentProcessId}`]
				: [1, `orphan (parent ${row.ParentProcessId} gone)`];
	// Descendants, then orphans (a shell whose parent exited can still hold a pipe), then the rest.
	const shown = rows
		.filter((row) => descendants.has(row.ProcessId) || WATCHED_NAMES.test(row.Name))
		.sort((a, b) => relation(a)[0] - relation(b)[0])
		.slice(0, MAX_ROWS)
		.map((row) => {
			const command = (row.CommandLine ?? "").replace(/\s+/gu, " ").slice(0, 220);
			return `  ${row.ProcessId} ${row.Name} [${relation(row)[1]}] ${row.CreationDate ?? ""} ${command}`;
		});
	console.error(
		[
			`[ci-hang] "${testName}" still running after ${Date.now() - startedAt}ms in worker ${process.pid}`,
			`[ci-hang] active resources: ${JSON.stringify(resources)}`,
			`[ci-hang] ${load}`,
			`[ci-hang] oldest in-flight filesystem requests (${pendingFs.size}):`,
			...oldestFs,
			`[ci-hang] processes (${rows.length} on host, ${descendants.size} descendants)${listing.error ? ` listing failed: ${listing.error}` : ""}:`,
			...shown,
		].join("\n"),
	);
}

let timer: NodeJS.Timeout | undefined;

beforeEach((context) => {
	const startedAt = Date.now();
	timer = setTimeout(
		() => {
			void report(context.task.name, startedAt);
		},
		Math.max(1_000, context.task.timeout - LEAD_MS),
	);
	timer.unref();
});

afterEach(() => {
	if (timer) clearTimeout(timer);
	timer = undefined;
});
