import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_ANCESTORS = 128;
const MAX_PROCESS_ROWS = 65_536;
const SNAPSHOT_TIMEOUT_MS = 2000;
// Windows PowerShell/CIM startup exceeded three seconds with eight concurrent owned observers
// alongside compilation. Five seconds bounds observation; arbitrary host contention can exceed it.
// Retain a bounded first observation; a missed deadline still denies termination.
const WINDOWS_SNAPSHOT_TIMEOUT_MS = 5000;

type ProtectionDiagnostic = (message: string) => void;

function refuseProtection(message: string, onDiagnostic?: ProtectionDiagnostic): undefined {
	onDiagnostic?.(message);
	return undefined;
}

function observationErrorCode(error: unknown): string {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return typeof code === "string" && /^[A-Z_]{1,32}$/.test(code) ? code : "unknown observer error";
}

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
	onDiagnostic?: ProtectionDiagnostic,
): ReadonlySet<number> | undefined {
	const protectedIds = new Set<number>([1]);
	const seen = new Set<number>();
	let pid = selfPid;
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		if (pid === 0 || pid === 1) return protectedIds;
		if (seen.has(pid)) return refuseProtection(`Process ancestry contains a cycle at PID ${pid}`, onDiagnostic);
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
			(record.groupId !== undefined && (!Number.isSafeInteger(record.groupId) || record.groupId < 0))
		)
			return refuseProtection(`Process ancestry record missing or malformed for PID ${pid}`, onDiagnostic);
		if (depth === 0 && record.parentPid !== parentPid)
			return refuseProtection(
				`Process ancestry parent mismatch for PID ${pid}: expected ${parentPid}, observed ${record.parentPid}`,
				onDiagnostic,
			);
		protectedIds.add(pid);
		if (record.groupId) protectedIds.add(record.groupId);
		pid = record.parentPid;
	}
	return refuseProtection(`Process ancestry exceeded ${MAX_ANCESTORS} generations`, onDiagnostic);
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

function readProcessTable(
	platform: NodeJS.Platform,
	onDiagnostic?: ProtectionDiagnostic,
): Map<number, ProcessParentRecord> | undefined {
	const windows = platform === "win32";
	const timeoutMs = windows ? WINDOWS_SNAPSHOT_TIMEOUT_MS : SNAPSHOT_TIMEOUT_MS;
	if (!windows && platform !== "darwin")
		return refuseProtection("Process ancestry platform is unsupported", onDiagnostic);
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
		timeout: timeoutMs,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.error)
		return refuseProtection(
			`Process ancestry snapshot failed: ${observationErrorCode(result.error)} (limit ${timeoutMs}ms)`,
			onDiagnostic,
		);
	if (result.status !== 0)
		return refuseProtection(`Process ancestry snapshot exited with status ${result.status}`, onDiagnostic);
	if (!result.stdout) return refuseProtection("Process ancestry snapshot was empty", onDiagnostic);
	const rows: unknown = windows
		? JSON.parse(result.stdout.replace(/^\uFEFF/, ""))
		: result.stdout.trim().split(/\r?\n/);
	if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_PROCESS_ROWS)
		return refuseProtection("Process ancestry snapshot has an invalid row count or shape", onDiagnostic);
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
				return refuseProtection("Process ancestry snapshot contains a malformed Windows row", onDiagnostic);
			record = { pid: row.ProcessId, parentPid: row.ParentProcessId };
		} else {
			if (typeof row !== "string" || !/^\s*\d+\s+\d+\s+\d+\s*$/.test(row))
				return refuseProtection("Process ancestry snapshot contains a malformed POSIX row", onDiagnostic);
			const fields = row.trim().split(/\s+/).map(Number);
			record = { pid: fields[0], parentPid: fields[1], groupId: fields[2] };
		}
		if (!Number.isSafeInteger(record.pid) || record.pid < 0 || records.has(record.pid))
			return refuseProtection("Process ancestry snapshot contains an invalid or duplicate PID", onDiagnostic);
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
export function createProcessTerminationProtectionReader(): (
	onDiagnostic?: ProtectionDiagnostic,
) => ReadonlySet<number> | undefined {
	let cached: { platform: NodeJS.Platform; pid: number; parentPid: number; ids: ReadonlySet<number> } | undefined;
	return (onDiagnostic) => {
		const platform = process.platform;
		const pid = process.pid;
		const parentPid = process.ppid;
		try {
			if (platform === "linux") return collectProtectedProcessIds(pid, parentPid, readLinuxParent, onDiagnostic);
			if (cached?.platform === platform && cached.pid === pid && cached.parentPid === parentPid) return cached.ids;
			const table = readProcessTable(platform, onDiagnostic);
			if (!table) return undefined;
			// Windows retains the creator PID after it exits instead of reparenting the child.
			// Only a successfully parsed complete snapshot establishes that historical absence.
			// On Windows, a recycled PID pointing back to an already visited ancestor or to itself
			// proves the historical creator is absent; end the observable chain cleanly.
			const visited = new Set<number>();
			const ids = collectProtectedProcessIds(
				pid,
				parentPid,
				(target) => {
					visited.add(target);
					const record = table.get(target);
					if (!record) return platform === "win32" ? null : undefined;
					if (platform === "win32" && (record.parentPid === target || visited.has(record.parentPid))) {
						return null;
					}
					return record;
				},
				onDiagnostic,
			);
			if (ids) cached = { platform, pid, parentPid, ids };
			return ids;
		} catch (error) {
			return refuseProtection(
				error instanceof SyntaxError
					? "Process ancestry snapshot contains malformed JSON"
					: `Process ancestry observation failed: ${observationErrorCode(error)}`,
				onDiagnostic,
			);
		}
	};
}

export const readProcessTerminationProtection = createProcessTerminationProtectionReader();
