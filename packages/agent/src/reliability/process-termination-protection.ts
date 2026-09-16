import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_ANCESTORS = 128;
const MAX_PROCESS_ROWS = 65_536;
const SNAPSHOT_TIMEOUT_MS = 2000;

export interface ProcessParentRecord {
	pid: number;
	parentPid: number;
	groupId?: number;
}

/**
 * Unknown ancestry cannot authorize a destructive signal. A null row explicitly proves an absent
 * historical parent in a complete Windows snapshot; undefined remains an observation failure.
 * No target liveness is inferred here.
 */
export function collectProtectedProcessIds(
	selfPid: number,
	parentPid: number,
	read: (pid: number) => ProcessParentRecord | null | undefined,
): ReadonlySet<number> | undefined {
	const protectedIds = new Set<number>([1]);
	const seen = new Set<number>();
	let pid = selfPid;
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		if (pid === 0 || pid === 1) return protectedIds;
		if (seen.has(pid)) return undefined;
		seen.add(pid);
		const record = read(pid);
		if (record === null && depth > 0) {
			protectedIds.add(pid);
			return protectedIds;
		}
		if (
			!record ||
			record.pid !== pid ||
			!Number.isSafeInteger(record.parentPid) ||
			record.parentPid < 0 ||
			(record.groupId !== undefined && (!Number.isSafeInteger(record.groupId) || record.groupId < 0)) ||
			(depth === 0 && record.parentPid !== parentPid)
		)
			return undefined;
		protectedIds.add(pid);
		if (record.groupId) protectedIds.add(record.groupId);
		pid = record.parentPid;
	}
	return undefined;
}

/** comm may contain spaces and closing parentheses; numeric stat fields begin after the last ')'. */
function readLinuxParent(pid: number): ProcessParentRecord | undefined {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	if (stat.length > 16384 || !stat.startsWith(`${pid} (`)) return undefined;
	const fields = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);
	if (!/^[A-Za-z]$/.test(fields[0] ?? "") || !/^\d+$/.test(fields[1] ?? "") || !/^\d+$/.test(fields[2] ?? ""))
		return undefined;
	return { pid, parentPid: Number(fields[1]), groupId: Number(fields[2]) };
}

function readProcessTable(platform: NodeJS.Platform): Map<number, ProcessParentRecord> | undefined {
	const windows = platform === "win32";
	if (!windows && platform !== "darwin") return undefined;
	const executable = windows
		? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		: "/bin/ps";
	const args = windows
		? [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
			]
		: ["-axo", "pid=,ppid=,pgid="];
	const result = spawnSync(executable, args, {
		encoding: "utf8",
		timeout: SNAPSHOT_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.error || result.status !== 0 || !result.stdout) return undefined;
	const rows: unknown = windows
		? JSON.parse(result.stdout.replace(/^\uFEFF/, ""))
		: result.stdout.trim().split(/\r?\n/);
	if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_PROCESS_ROWS) return undefined;
	const records = new Map<number, ProcessParentRecord>();
	for (const row of rows) {
		let record: ProcessParentRecord;
		if (windows) {
			if (
				!row ||
				typeof row !== "object" ||
				!("ProcessId" in row) ||
				!("ParentProcessId" in row) ||
				typeof row.ProcessId !== "number" ||
				typeof row.ParentProcessId !== "number"
			)
				return undefined;
			record = { pid: row.ProcessId, parentPid: row.ParentProcessId };
		} else {
			if (typeof row !== "string" || !/^\s*\d+\s+\d+\s+\d+\s*$/.test(row)) return undefined;
			const fields = row.trim().split(/\s+/).map(Number);
			record = { pid: fields[0], parentPid: fields[1], groupId: fields[2] };
		}
		if (!Number.isSafeInteger(record.pid) || record.pid < 0 || records.has(record.pid)) return undefined;
		records.set(record.pid, record);
	}
	return records;
}

/**
 * Linux reads the live bounded ancestry directly. The other supported hosts need a process-table
 * command: retain a successful launch-ancestry snapshot while self/parent identity is unchanged.
 * This protects the hosting chain and groups, not unrelated processes or recycled target PIDs.
 * On Windows a proven absent historical creator ends the observable chain; surviving older
 * ancestors beyond that break cannot be reconstructed from the current process table.
 */
export function createProcessTerminationProtectionReader(): () => ReadonlySet<number> | undefined {
	let cached: { platform: NodeJS.Platform; pid: number; parentPid: number; ids: ReadonlySet<number> } | undefined;
	return () => {
		const platform = process.platform;
		const pid = process.pid;
		const parentPid = process.ppid;
		try {
			if (platform === "linux") return collectProtectedProcessIds(pid, parentPid, readLinuxParent);
			if (cached?.platform === platform && cached.pid === pid && cached.parentPid === parentPid) return cached.ids;
			const table = readProcessTable(platform);
			if (!table) return undefined;
			// Windows retains the creator PID after it exits instead of reparenting the child.
			// Only a successfully parsed complete snapshot establishes that historical absence.
			const ids = collectProtectedProcessIds(
				pid,
				parentPid,
				(target) => table.get(target) ?? (platform === "win32" ? null : undefined),
			);
			if (ids) cached = { platform, pid, parentPid, ids };
			return ids;
		} catch {
			return undefined;
		}
	};
}

export const readProcessTerminationProtection = createProcessTerminationProtectionReader();
