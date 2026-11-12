/** Bounded process-end records shared by native health and terminal-detachment journeys. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORD_COUNT = 100;

export function readProcessEndRecord(directory, name) {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(\d+)-(\d+)(\.routine)?\.txt$/.exec(name);
	if (!match) throw new Error(`unclassifiable process-end record ${name}`);
	const path = join(directory, name);
	const initial = lstatSync(path);
	if (!initial.isFile() || initial.isSymbolicLink()) throw new Error(`process-end record ${name} is not a regular file`);
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	let text;
	try {
		const metadata = fstatSync(descriptor);
		if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES)
			throw new Error(`process-end record ${name} exceeds its regular-file size bound`);
		const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(descriptor, bytes, length, bytes.length - length, length);
			if (count === 0) break;
			length += count;
		}
		if (length > MAX_RECORD_BYTES) throw new Error(`process-end record ${name} grew past its size bound`);
		text = bytes.subarray(0, length).toString("utf8");
	} finally {
		closeSync(descriptor);
	}
	const at = Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
	const pid = Number(match[5]);
	const sequence = Number(match[6]);
	const lines = text.split(/\r?\n/);
	const recordPid = /^pid (\d+)$/.exec(lines[1] ?? "");
	const recordAt = /^at (.+)$/.exec(lines[2] ?? "");
	const bodyAt = recordAt ? Date.parse(recordAt[1]) : Number.NaN;
	if (!lines[0]?.trim() || !Number.isFinite(at) || !Number.isSafeInteger(pid) || pid < 1 ||
		!Number.isSafeInteger(sequence) || sequence < 1 || !recordPid || Number(recordPid[1]) !== pid ||
		!Number.isFinite(bodyAt) || Math.abs(bodyAt - at) > 1000)
		throw new Error(`malformed process-end record ${name}`);
	return { at, pid, sequence, routine: match[7] !== undefined, reason: lines[0].split(";", 1)[0].trim() };
}

export function fatalProcessRecordProblems(agents, since) {
	const problems = [];
	for (const { directory, label } of agents) {
		const root = join(directory, "state", "crashes");
		let names;
		try {
			names = readdirSync(root);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			problems.push(`${label}: crash-record directory is unreadable`);
			continue;
		}
		const fatal = names.filter((name) => name.endsWith(".txt") && !name.endsWith(".routine.txt"));
		if (fatal.length > MAX_RECORD_COUNT) {
			problems.push(`${label}: crash-record count exceeds the ${MAX_RECORD_COUNT}-record bound`);
			continue;
		}
		for (const name of fatal) {
			try {
				const record = readProcessEndRecord(root, name);
				if (record.at >= since)
					problems.push(`${label}: fatal process crash at ${new Date(record.at).toISOString()} (pid ${record.pid})`);
			} catch (error) {
				problems.push(`${label}: ${error.message}`);
			}
		}
	}
	return problems;
}

/** An identified, declared end is required: PID disappearance alone could also mean a forced kill. */
export function detachedProcessEnd(directory, pid, since) {
	const root = join(directory, "state", "crashes");
	let names;
	try {
		names = readdirSync(root).filter((name) => new RegExp(`-${pid}-\\d+\\.routine\\.txt$`).test(name));
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	if (names.length > MAX_RECORD_COUNT) throw new Error("Detached process-end records exceed their bound");
	const records = names.map((name) => readProcessEndRecord(root, name)).filter((record) => record.at >= since);
	const latest = records.sort((left, right) => right.sequence - left.sequence)[0];
	if (!latest) return undefined;
	if (!latest.routine || latest.pid !== pid || !["dead-terminal", "signal-graceful", "wind-down"].includes(latest.reason))
		throw new Error(`Detached runtime ${pid} ended without cooperative terminal cleanup: ${latest.reason}`);
	return latest;
}
