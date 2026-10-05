/**
 * Tamper detection and attribution for the harness write-protected set.
 *
 * The structural `write`/`edit` tools refuse harness resources (skills, extensions, prompts, profiles, hooks,
 * git config, ...). A worker's `bash`, `python` and `run_process` are host-trust boundaries by design: a shell
 * redirect reaches any file the OS account can write, and no sandbox is available to close that. This module
 * does not try to: it never refuses and never reverts. It fingerprints the protected set (size and mtime,
 * bounded in entry count and depth) around each process-tool call and again across the whole run, and records
 * every change as a finding that names the worker, the path and the before/after fingerprints. The parent
 * receives the findings through the worker claim (blockers, parent review required), so a change the structural
 * boundary could not stop is still seen, attributed and reviewable.
 *
 * What is NOT watched, on purpose: stores the host itself writes continuously (`state/`, `cache/`, `work/`,
 * `sessions/`, `memory/`, ...) and credential/memory files the host rewrites (`auth.json`, `MEMORY.md`,
 * `USER.md`). A baseline over those would flag every check. They stay covered by the structural read/write
 * denials only. A finding says a protected path changed while this worker's command (or run) was in progress;
 * it is evidence for review, not proof of authorship, because the root or another worker may also have written.
 */

import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { hostWroteDuring } from "../../utils/host-write-window.ts";
import { AGENT_ROOT_DIRECTORY_NAMES, AGENT_ROOT_FILE_NAMES } from "../agent-paths.ts";
import { HOST_FINDING_PREFIX } from "./host-finding-prefixes.ts";
import { getHarnessWriteProtectedPaths } from "./lane-private-paths.ts";

/** Agent-root entries the host writes during normal operation; fingerprinting them would only produce noise. */
const HOST_WRITTEN_AGENT_ROOT_ENTRIES: ReadonlySet<string> = new Set<string>([
	"state",
	"cache",
	"work",
	"sessions",
	"memory",
	"okf-memory",
	"runtimes",
	"models",
	"npm",
	"git",
	"worktrees",
	"auth.json",
	"MEMORY.md",
	"USER.md",
]);

const DEFAULT_MAX_ENTRIES = 2_048;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FINDINGS = 24;

/**
 * The write-protected set minus what the host itself writes: the configuration and executable surface a process
 * tool could silently rewrite (skills, extensions, prompts, profiles, bin, root config files, project `.pi`
 * files, `.husky`, `.git/config`, `.git/hooks`).
 */
export function getTamperWatchedPaths(cwd: string, agentDir: string): string[] {
	const excluded = new Set(
		[...AGENT_ROOT_FILE_NAMES, ...AGENT_ROOT_DIRECTORY_NAMES]
			.filter((name) => HOST_WRITTEN_AGENT_ROOT_ENTRIES.has(name))
			.map((name) => path.join(agentDir, name)),
	);
	return getHarnessWriteProtectedPaths(cwd, agentDir).filter((entry) => !excluded.has(entry));
}

export interface ProtectedPathFinding {
	/** Worker the finding is attributed to (observed while this worker's command or run was in progress). */
	readonly workerId: string;
	readonly path: string;
	/** Fingerprint before: `absent`, `file:<size>:<mtimeMs>`, `dir:<mtimeMs>` or `link:<mtimeMs>`. */
	readonly before: string;
	readonly after: string;
	/** `command`: changed between the start and end of one process-tool call. `run`: changed since the worker started. */
	readonly scope: "command" | "run";
}

export interface ProtectedPathWatchOptions {
	workerId: string;
	paths: readonly string[];
	maxEntries?: number;
	maxDepth?: number;
	maxFindings?: number;
}

type Fingerprints = Map<string, string>;

/** Longest claim blocker the host keeps (`MAX_WORKER_CLAIM_BLOCKER_CHARS` is 1000); a longer one is dropped whole. */
const MAX_BLOCKER_CHARS = 960;

function clipBlocker(line: string): string {
	return line.length > MAX_BLOCKER_CHARS ? `${line.slice(0, MAX_BLOCKER_CHARS - 1)}\u2026` : line;
}

function fingerprintOf(target: string): string {
	try {
		const stat = lstatSync(target);
		const mtime = Math.trunc(stat.mtimeMs);
		if (stat.isSymbolicLink()) return `link:${mtime}`;
		if (stat.isDirectory()) return `dir:${mtime}`;
		return `file:${stat.size}:${mtime}`;
	} catch {
		return "absent";
	}
}

/** Bounded, deterministic depth-first fingerprint of every watched root. Returns whether the bound cut it short. */
function fingerprint(
	roots: readonly string[],
	maxEntries: number,
	maxDepth: number,
): { entries: Fingerprints; truncated: boolean } {
	const entries: Fingerprints = new Map();
	let truncated = false;
	const visit = (target: string, depth: number): void => {
		if (entries.size >= maxEntries) {
			truncated = true;
			return;
		}
		const print = fingerprintOf(target);
		entries.set(target, print);
		if (!print.startsWith("dir:")) return;
		if (depth >= maxDepth) {
			truncated = true;
			return;
		}
		let names: string[];
		try {
			names = readdirSync(target).sort();
		} catch {
			return;
		}
		for (const name of names) visit(path.join(target, name), depth + 1);
	};
	for (const root of roots) visit(root, 0);
	return { entries, truncated };
}

function changesBetween(before: Fingerprints, after: Fingerprints): { path: string; before: string; after: string }[] {
	const changes: { path: string; before: string; after: string }[] = [];
	for (const [target, was] of before) {
		const now = after.get(target) ?? "absent";
		if (was !== now) changes.push({ path: target, before: was, after: now });
	}
	for (const [target, now] of after) {
		if (!before.has(target)) changes.push({ path: target, before: "absent", after: now });
	}
	return changes;
}

export class ProtectedPathWatch {
	private readonly options: Required<Omit<ProtectedPathWatchOptions, "workerId" | "paths">> &
		Pick<ProtectedPathWatchOptions, "workerId" | "paths">;
	private readonly recorded: ProtectedPathFinding[] = [];
	private readonly seen = new Set<string>();
	private omitted = 0;
	private runBaseline: Fingerprints | undefined;
	private runBaselineAt = 0;
	private truncatedWatch = false;

	constructor(options: ProtectedPathWatchOptions) {
		this.options = {
			workerId: options.workerId,
			paths: options.paths.map((entry) => path.resolve(entry)),
			maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
			maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
			maxFindings: options.maxFindings ?? DEFAULT_MAX_FINDINGS,
		};
	}

	private snapshot(): Fingerprints {
		const { entries, truncated } = fingerprint(this.options.paths, this.options.maxEntries, this.options.maxDepth);
		if (truncated) this.truncatedWatch = true;
		return entries;
	}

	private record(change: { path: string; before: string; after: string }, scope: ProtectedPathFinding["scope"]): void {
		const key = `${scope}\0${change.path}`;
		if (this.seen.has(key)) return;
		this.seen.add(key);
		if (this.recorded.length >= this.options.maxFindings) {
			this.omitted += 1;
			return;
		}
		this.recorded.push({ workerId: this.options.workerId, scope, ...change });
	}

	/** Take the lane-start baseline (idempotent: the first call wins). */
	start(): void {
		if (this.runBaseline) return;
		this.runBaselineAt = Date.now();
		this.runBaseline = this.snapshot();
	}

	/**
	 * Run one process-tool call between two snapshots. A change in between is recorded against this worker's
	 * command; the call's own result and error always pass through untouched, and a failure to fingerprint can
	 * never fail the call.
	 */
	async guard<T>(run: () => Promise<T>): Promise<T> {
		this.start();
		let before: Fingerprints | undefined;
		const startedAt = Date.now();
		try {
			before = this.snapshot();
		} catch {
			before = undefined;
		}
		try {
			return await run();
		} finally {
			try {
				if (before) {
					const endedAt = Date.now();
					for (const change of changesBetween(before, this.snapshot())) {
						if (!hostWroteDuring(change.path, startedAt, endedAt)) this.record(change, "command");
					}
				}
			} catch {
				// Detection is evidence, never a gate: an unreadable path cannot fail the worker's command.
			}
		}
	}

	/**
	 * The end-of-run comparison against the lane-start baseline, which also catches a change made by a process
	 * the worker left running between calls. Returns every finding recorded so far (command and run scopes).
	 */
	finish(): readonly ProtectedPathFinding[] {
		try {
			if (this.runBaseline) {
				const alreadyReported = new Set(this.recorded.map((finding) => finding.path));
				const endedAt = Date.now();
				for (const change of changesBetween(this.runBaseline, this.snapshot())) {
					if (!alreadyReported.has(change.path) && !hostWroteDuring(change.path, this.runBaselineAt, endedAt)) {
						this.record(change, "run");
					}
				}
			}
		} catch {
			// See guard(): unreadable paths are skipped, never raised.
		}
		return this.recorded;
	}

	/** Run the end-of-run comparison, then return the claim blocker lines for everything recorded. */
	finishBlockers(): string[] {
		this.finish();
		return this.blockers();
	}

	/**
	 * Claim blocker lines for the findings so far, one per finding plus one disclosure line when the finding bound
	 * cut it short. Each line fits a claim blocker (a longer line would be dropped by claim normalization).
	 */
	blockers(): string[] {
		const lines = this.recorded.map((finding) =>
			clipBlocker(
				`${HOST_FINDING_PREFIX.protectedPath} ${finding.path} (${finding.before} -> ${finding.after}) changed while worker ${finding.workerId}'s ${finding.scope === "command" ? "command was running" : "run was in progress"}. A process tool can write harness files the structural write tool refuses: review it and revert it if unintended. Not proof of authorship; the root or another worker may also have written.`,
			),
		);
		if (this.omitted > 0) {
			lines.push(
				`${HOST_FINDING_PREFIX.protectedPath} ${this.omitted} further protected-path change(s) not listed.`,
			);
		}
		return lines;
	}

	/** True when the entry or depth bound cut a snapshot short, so part of the set was not fingerprinted. */
	get truncated(): boolean {
		return this.truncatedWatch;
	}
}
