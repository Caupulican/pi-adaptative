/** Linux-only PTY child custody for the terminal-detachment acceptance journey. */
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, opendirSync, readlinkSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_STAT = 16_384;
const MAX_CUSTODY = 8_192;
const MAX_PROCESSES = 32_768;
const MAX_MEMBERS = 512;

function boundedFile(path, max) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_CLOEXEC);
	try {
		const buffer = Buffer.alloc(max + 1);
		let count = 0;
		while (count < buffer.length) {
			const n = readSync(fd, buffer, count, buffer.length - count, null);
			if (n === 0) break;
			count += n;
		}
		if (count > max) throw new Error(`Custody input exceeds ${max} bytes`);
		return buffer.subarray(0, count).toString("utf8");
	} finally { closeSync(fd); }
}

/** PID/start ticks/SID bind signals to the originally observed Linux process. */
export function readLinuxProcessIdentity(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid custody PID");
	let stat;
	try { stat = boundedFile(`/proc/${pid}/stat`, MAX_STAT); }
	catch (error) { if (error?.code === "ENOENT" || error?.code === "ESRCH") return undefined; throw error; }
	if (!stat.startsWith(`${pid} (`)) throw new Error("Malformed process identity");
	const end = stat.lastIndexOf(")");
	if (end < 0) throw new Error("Malformed process identity");
	const fields = stat.slice(end + 1).trim().split(/\s+/);
	if (!/^[A-Za-z]$/.test(fields[0] ?? "") || ![fields[1], fields[2], fields[3], fields[19]].every((value) => /^\d+$/.test(value ?? "")))
		throw new Error("Malformed process identity");
	const [parentPid, groupId, sessionId] = fields.slice(1, 4).map(Number);
	if (![parentPid, groupId, sessionId].every(Number.isSafeInteger)) throw new Error("Invalid process identity fields");
	return { pid, parentPid, groupId, sessionId, startTime: fields[19], state: fields[0] };
}

export function sameLinuxProcessIdentity(expected, actual) {
	return expected !== undefined && actual !== undefined && expected.pid === actual.pid && expected.startTime === actual.startTime && expected.sessionId === actual.sessionId;
}

function validateIdentity(value) {
	return value && Number.isSafeInteger(value.pid) && value.pid > 1 && Number.isSafeInteger(value.parentPid) &&
		Number.isSafeInteger(value.groupId) && Number.isSafeInteger(value.sessionId) && /^\d+$/.test(value.startTime ?? "") &&
		typeof value.state === "string" && /^[A-Za-z]$/.test(value.state);
}

/** Read the pane anchor's bounded PTY identity; the gate owns the separately spawned child. */
export function readTerminalAnchor(path) {
	const initial = lstatSync(path);
	if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("Custody record is not a regular file");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let value;
	try {
		const actual = fstatSync(fd);
		if (!actual.isFile() || actual.dev !== initial.dev || actual.ino !== initial.ino || actual.size > MAX_CUSTODY)
			throw new Error("Custody record changed or exceeded its bound");
		const buffer = Buffer.alloc(MAX_CUSTODY + 1);
		const count = readSync(fd, buffer, 0, buffer.length, 0);
		if (count > MAX_CUSTODY) throw new Error("Custody record exceeds its bound");
		value = JSON.parse(buffer.subarray(0, count).toString("utf8"));
	} finally { closeSync(fd); }
	if (value?.version !== 2 || !validateIdentity(value.anchor) ||
		!value.tty || !/^\/dev\/pts\/\d+$/.test(value.tty.path ?? "") || ![value.tty.dev, value.tty.ino, value.tty.rdev].every((item) => typeof item === "string" && /^\d+$/.test(item)))
		throw new Error("Invalid terminal anchor record");
	return value;
}

/** The leader must remain the original process throughout the bounded session scan. */
function scanSession(sessionId) {
	const members = [];
	const directory = opendirSync("/proc");
	let scanned = 0;
	try {
		for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
			if (!/^\d+$/.test(entry.name)) continue;
			if (++scanned > MAX_PROCESSES) throw new Error("Process scan exceeds custody bound");
			const pid = Number(entry.name);
			if (!Number.isSafeInteger(pid) || pid <= 1) continue;
			const identity = readLinuxProcessIdentity(pid);
			if (identity?.sessionId !== sessionId || identity.state === "Z") continue;
			if (members.length >= MAX_MEMBERS) throw new Error("Isolated session exceeds custody bound");
			members.push(identity);
		}
	} finally { directory.closeSync(); }
	return members;
}

export function snapshotIsolatedSession(custody) {
	if (!sameLinuxProcessIdentity(custody.child, readLinuxProcessIdentity(custody.child.pid))) throw new Error("Isolated session leader identity is not live");
	const members = scanSession(custody.child.sessionId);
	if (!sameLinuxProcessIdentity(custody.child, readLinuxProcessIdentity(custody.child.pid))) throw new Error("Isolated session leader changed during scan");
	return members;
}

/** Never signal a PID whose observed start ticks and session no longer match. */
export function signalIsolatedProcess(identity, signal) {
	if (!validateIdentity(identity) || identity.pid === process.pid || !["SIGHUP", "SIGTERM", "SIGKILL"].includes(signal))
		throw new Error("Invalid isolated process signal request");
	const current = readLinuxProcessIdentity(identity.pid);
	if (!current || current.state === "Z") return false;
	if (!sameLinuxProcessIdentity(identity, current)) throw new Error(`Refusing reused or foreign PID ${identity.pid}`);
	try { process.kill(identity.pid, signal); return true; }
	catch (error) { if (error?.code === "ESRCH") return false; throw error; }
}

/** Bounded cleanup of previously attested members; no later numeric-SID-only process is signaled. */
export async function cleanupIsolatedSession(custody, snapshot) {
	if (!Array.isArray(snapshot) || snapshot.length > MAX_MEMBERS || !snapshot.every((item) => validateIdentity(item) && item.sessionId === custody.child.sessionId))
		throw new Error("Invalid isolated-session snapshot");
	const members = new Map(snapshot.map((item) => [item.pid, item]));
	if (!sameLinuxProcessIdentity(custody.child, members.get(custody.child.pid))) throw new Error("Session snapshot lacks its original leader");
	const failures = [];
	for (const [signal, delay] of [["SIGTERM", 250], ["SIGKILL", 500]]) {
		try {
			const witness = [...members.values()].find((member) => {
				const current = readLinuxProcessIdentity(member.pid);
				return sameLinuxProcessIdentity(member, current) && current.state !== "Z";
			});
			const observed = scanSession(custody.child.sessionId);
			const stillLive = witness && readLinuxProcessIdentity(witness.pid);
			if (witness && sameLinuxProcessIdentity(witness, stillLive) && stillLive.state !== "Z") {
				for (const member of observed) members.set(member.pid, member);
			} else {
				for (const member of observed)
					if (!sameLinuxProcessIdentity(members.get(member.pid), member)) throw new Error("Unproven process remains in the isolated session");
			}
		} catch (error) { failures.push(error); }
		for (const member of members.values()) {
			try { signalIsolatedProcess(member, signal); } catch (error) { failures.push(error); }
		}
		await new Promise((resolve) => setTimeout(resolve, delay));
		let done = false;
		try {
			if ([...members.values()].every((member) => { const now = readLinuxProcessIdentity(member.pid); return !now || now.state === "Z"; })) {
				if (scanSession(custody.child.sessionId).length !== 0) throw new Error("Unproven process remains in the isolated session");
				done = true;
			}
		} catch (error) { failures.push(error); }
		if (done) {
			if (failures.length) throw new AggregateError(failures, "Isolated session cleanup had failures");
			return;
		}
	}
	throw new AggregateError([...failures, new Error("Isolated session cleanup did not prove complete within its bound")], "Isolated session cleanup failed");
}

function terminalIdentity(pid, fd) {
	const path = readlinkSync(`/proc/${pid}/fd/${fd}`);
	if (!/^\/dev\/pts\/\d+$/.test(path)) throw new Error("Isolated child stdio is not a PTY slave");
	const stat = statSync(`/proc/${pid}/fd/${fd}`, { bigint: true });
	if (!stat.isCharacterDevice()) throw new Error("Isolated child stdio is not a terminal device");
	return { path, dev: String(stat.dev), ino: String(stat.ino), rdev: String(stat.rdev) };
}

/** Spawn from the independent gate, retaining the ChildProcess before any asynchronous acknowledgement. */
export function spawnOwnedPiSession(anchor, executable, args, options) {
	if (process.platform !== "linux" || typeof executable !== "string" || !isAbsolute(executable) || !Array.isArray(args) || !args.every((item) => typeof item === "string") ||
		!options || typeof options.cwd !== "string" || !isAbsolute(options.cwd) || !options.env || typeof options.env !== "object" ||
		!Object.values(options.env).every((value) => value === undefined || typeof value === "string"))
		throw new Error("Invalid isolated Pi spawn request");
	if (!sameLinuxProcessIdentity(anchor.anchor, readLinuxProcessIdentity(anchor.anchor.pid))) throw new Error("Terminal anchor is no longer live");
	const fd = openSync(anchor.tty.path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NOFOLLOW);
	let child;
	let closeFailure;
	let spawnFailure;
	try {
		const actual = fstatSync(fd, { bigint: true });
		if (!actual.isCharacterDevice() || String(actual.dev) !== anchor.tty.dev || String(actual.ino) !== anchor.tty.ino || String(actual.rdev) !== anchor.tty.rdev ||
			!sameLinuxProcessIdentity(anchor.anchor, readLinuxProcessIdentity(anchor.anchor.pid))) throw new Error("Terminal anchor changed before spawn");
		child = spawn(executable, args, { cwd: options.cwd, env: options.env, detached: true, stdio: [fd, fd, fd] });
	} catch (error) {
		spawnFailure = error;
	} finally {
		try { closeSync(fd); } catch (error) { closeFailure = error; }
	}
	if (spawnFailure) {
		if (closeFailure) throw new AggregateError([spawnFailure, closeFailure], "Pi spawn and PTY descriptor cleanup failed");
		throw spawnFailure;
	}
	const started = new Promise((resolve, reject) => {
		child.once("spawn", () => closeFailure ? reject(closeFailure) : resolve());
		child.once("error", reject);
	});
	void started.catch(() => {});
	let childError;
	child.on("error", (error) => { childError ??= error; });
	const exited = new Promise((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal, ...(childError ? { error: childError } : {}) }));
	});
	return { child, started, exited };
}

/** Validate the actual spawned child, including its new SID and inherited PTY, before any pane close. */
export function attestOwnedPiSession(anchor, child) {
	if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) throw new Error("Pi child has no valid PID");
	const identity = readLinuxProcessIdentity(child.pid);
	if (!identity || identity.parentPid !== process.pid || identity.sessionId !== identity.pid || identity.groupId !== identity.pid || identity.sessionId === anchor.anchor.sessionId)
		throw new Error("Pi did not enter its own verified session");
	for (const fd of [0, 1, 2])
		if (JSON.stringify(terminalIdentity(child.pid, fd)) !== JSON.stringify(anchor.tty)) throw new Error("Pi did not inherit the attested PTY");
	if (!sameLinuxProcessIdentity(identity, readLinuxProcessIdentity(child.pid))) throw new Error("Pi identity changed during attestation");
	return { anchor: anchor.anchor, child: identity, tty: anchor.tty };
}

/** Failed spawn/attestation still retains the gate's child handle and attempts bounded cleanup. */
export async function cleanupUnattestedPiSession(owned) {
	const pid = owned.child?.pid;
	const failures = [];
	try {
		if (pid !== undefined) {
			const identity = readLinuxProcessIdentity(pid);
			if (identity && identity.state !== "Z") {
				if (identity.parentPid !== process.pid || identity.sessionId !== pid || identity.groupId !== pid)
					throw new Error("Unattested Pi child identity cannot be safely cleaned up");
				await cleanupIsolatedSession({ child: identity }, [identity]);
			} else if (scanSession(pid).length > 0) {
				throw new Error("Unattested Pi leader ended with an unproven session member");
			}
		}
	} catch (error) { failures.push(error); }
	let timer;
	try {
		await Promise.race([
			owned.exited,
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Unattested Pi child did not close")), 1_000); }),
		]);
	} catch (error) { failures.push(error); }
	finally { clearTimeout(timer); }
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Unattested Pi cleanup and child join failed");
}

async function main() {
	if (process.platform !== "linux") throw new Error("Isolated terminal custody requires Linux");
	const [flag, path, ...extra] = process.argv.slice(2);
	if (flag !== "--anchor" || !path || !isAbsolute(path) || extra.length) throw new Error("Usage: live-isolated-terminal-child --anchor <absolute-path>");
	const anchor = readLinuxProcessIdentity(process.pid);
	if (!anchor) throw new Error("Terminal anchor identity is unavailable");
	const tty = terminalIdentity(process.pid, 0);
	for (const fd of [1, 2]) if (JSON.stringify(terminalIdentity(process.pid, fd)) !== JSON.stringify(tty)) throw new Error("Anchor stdio does not share one PTY");
	const data = `${JSON.stringify({ version: 2, anchor, tty })}\n`;
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
	try { linkSync(temp, path); } finally { unlinkSync(temp); }
	await new Promise(() => { setInterval(() => {}, 2 ** 30); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => { process.stderr.write(`Isolated terminal custody failed: ${error.message}\n`); process.exitCode = 1; });
}
