/**
 * Which machine a recorded pid belongs to.
 *
 * A pid only means something on the host that issued it, so every record that lets a later process judge
 * an owner by pid (process-matrix entries, worktree-sync lane and integration-lock owners) also records
 * the host. `os.hostname()` alone cannot be that identity: it changes with a rename or a network switch,
 * after which a machine's own records look foreign and are never reclaimed. The stable identity is the
 * OS machine id, read once per process and recorded as a digest:
 * - Linux: `/etc/machine-id`, else `/var/lib/dbus/machine-id`.
 * - macOS: `IOPlatformUUID` from `ioreg` (spawned without a shell, bounded, once per process).
 * - Windows: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` via `reg.exe` (same bounded pattern).
 * Linux reads a file synchronously. macOS and Windows need a process spawn, which must never block startup: they are
 * read asynchronously by `warmHostIdentity()` (started once by the process-matrix runtime), and `readHostIdentity()`
 * reports the machine id only once that read has finished. A record written before then carries only the hostname.
 * When none is readable the process records no machine id, and only the hostname identifies it.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

/** Bound on the one macOS/Windows machine-id read a process performs. */
const MACHINE_ID_READ_TIMEOUT_MS = 3_000;

export interface HostIdentity {
	/** Digest of the OS machine id; undefined when the OS exposes none this process could read. */
	machineId: string | undefined;
	/** `os.hostname()` at the time of the read. Records written before machine ids carry only this. */
	hostname: string;
}

/**
 * The host a record names. Writers record `hostname` always and `machineId` when they could read one. A record
 * naming neither identifies no host and never matches one; a caller that knows such records are local (they
 * predate host recording) decides that itself.
 */
export interface RecordedHost {
	machineId?: string;
	hostname?: string;
}

let cachedMachineId: { value: string | undefined } | undefined;

let warming: Promise<void> | undefined;

/**
 * This process's host identity. The machine id is read once per process (Linux: synchronously here; macOS and Windows:
 * by `warmHostIdentity()`, undefined until that read finishes); the hostname is read live.
 */
export function readHostIdentity(): HostIdentity {
	if (process.platform === "linux") cachedMachineId ??= { value: digest(readLinuxMachineId()) };
	return { machineId: cachedMachineId?.value, hostname: osHostname() };
}

/** Starts (once) the bounded, shell-less machine-id read macOS and Windows need. Never rejects; a no-op elsewhere. */
export function warmHostIdentity(): Promise<void> {
	if (process.platform === "linux" || cachedMachineId) return Promise.resolve();
	warming ??= readPlatformMachineId().then((raw) => {
		cachedMachineId = { value: digest(raw) };
	});
	return warming;
}

/**
 * Whether `recorded` names the host `local` describes. A record carrying a machine id is judged by the machine
 * id alone: equal hostnames on different machines never match, and a renamed machine still matches itself. A
 * record without one predates machine ids (or came from a host that exposes none) and is judged by hostname, as
 * before. A process that cannot read its own machine id therefore never claims a record that carries one.
 */
export function isRecordedOnHost(recorded: RecordedHost, local: HostIdentity): boolean {
	if (recorded.machineId !== undefined) return recorded.machineId === local.machineId;
	return recorded.hostname !== undefined && recorded.hostname === local.hostname;
}

function digest(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	return createHash("sha256").update(`pi-host-identity\0${process.platform}\0${raw}`).digest("hex").slice(0, 32);
}

async function readPlatformMachineId(): Promise<string | undefined> {
	if (process.platform === "darwin") return readDarwinPlatformUuid();
	if (process.platform === "win32") return readWindowsMachineGuid();
	return undefined;
}

function readLinuxMachineId(): string | undefined {
	for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
		let text: string;
		try {
			text = readFileSync(path, "utf8").trim().toLowerCase();
		} catch {
			continue;
		}
		// An empty, `uninitialized` or all-zero file is an image that never got its own id.
		if (/^[0-9a-f]{32}$/.test(text) && !/^0+$/.test(text)) return text;
	}
	return undefined;
}

async function readDarwinPlatformUuid(): Promise<string | undefined> {
	const output = await runBounded("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
	return normalizeUuid(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(output ?? "")?.[1]);
}

async function readWindowsMachineGuid(): Promise<string | undefined> {
	const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
	// `/reg:64`: a 32-bit process is otherwise redirected to the WOW6432Node view, which has no MachineGuid.
	const output = await runBounded(reg, [
		"query",
		"HKLM\\SOFTWARE\\Microsoft\\Cryptography",
		"/v",
		"MachineGuid",
		"/reg:64",
	]);
	return normalizeUuid(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/.exec(output ?? "")?.[1]);
}

function normalizeUuid(value: string | undefined): string | undefined {
	const uuid = value?.toLowerCase();
	if (uuid === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid))
		return undefined;
	return /^[0-]+$/.test(uuid) ? undefined : uuid;
}

/** stdout of a direct (shell-less) executable run, or undefined when it failed, timed out or exited non-zero. */
function runBounded(file: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			file,
			args,
			{ encoding: "utf8", timeout: MACHINE_ID_READ_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
			(error, stdout) => resolve(error ? undefined : stdout),
		);
	});
}
