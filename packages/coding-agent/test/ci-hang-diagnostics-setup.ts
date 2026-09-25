/**
 * CI hang evidence (enabled by PI_CI_HANG_DIAGNOSTICS=1 on the Windows test steps).
 *
 * Windows runners intermittently stall a test for 30-70s where the host never does, so the cause
 * has to be read on the runner. A test still running shortly before its timeout prints what this
 * worker is waiting on (active libuv resources) and the processes that could hold it: this worker's
 * descendants, plus every shell, interpreter and git process on the machine with its parent, so an
 * orphan still holding a pipe shows up even after its parent exited. Output is bounded stderr.
 */
import { execFile } from "node:child_process";
import { afterEach, beforeEach } from "vitest";

const LEAD_MS = 5_000;
const WATCHED_NAMES =
	/^(?:bash|sh|dash|python\d*(?:\.\d+)?|pythonw?|uv|node|git|git-remote-https|powershell|pwsh|cmd|taskkill)\.exe$/iu;
const MAX_ROWS = 60;

interface ProcessRow {
	ProcessId: number;
	ParentProcessId: number;
	Name: string;
	CommandLine: string | null;
	CreationDate: string | null;
}

function listProcesses(): Promise<ProcessRow[]> {
	const script =
		"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='CreationDate';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress";
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout) => {
				if (error) return resolve([]);
				try {
					const parsed = JSON.parse(stdout) as ProcessRow | ProcessRow[];
					resolve(Array.isArray(parsed) ? parsed : [parsed]);
				} catch {
					resolve([]);
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
	const rows = await listProcesses();
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
			`[ci-hang] processes (${rows.length} on host, ${descendants.size} descendants):`,
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
