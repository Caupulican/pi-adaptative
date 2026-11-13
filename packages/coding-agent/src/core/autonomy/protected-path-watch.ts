/**
 * Tamper detection and attribution for the harness write-protected set.
 *
 * The structural `write`/`edit` tools refuse harness resources (skills, extensions, prompts, profiles, hooks,
 * git config, ...). A worker's `bash`, `python` and `run_process` are host-trust boundaries by design: a shell
 * redirect reaches any file the OS account can write, and no sandbox is available to close that. This module
 * does not try to: it never refuses and never reverts. It fingerprints the protected set (exact path identity,
 * bounded in entry count and depth) around each process-tool call and again across the whole run, and records
 * every change as a finding that names the worker, the path and the before/after fingerprints. The parent
 * receives the findings through the worker claim (blockers, parent review required), so a change the structural
 * boundary could not stop is still seen, attributed and reviewable.
 *
 * What is NOT watched, on purpose: stores the host itself writes continuously (`state/`, `cache/`, `work/`,
 * `sessions/`, `memory/`, ...) and credential/memory files the host rewrites (`auth.json`, `MEMORY.md`,
 * `USER.md`). A baseline over those would flag every check. They stay covered by the structural read/write
 * denials only. A finding says a protected path changed while this worker's command (or run) was in progress;
 * it is evidence for review, not proof of authorship, because the root or another worker may also have written. A host
 * change is discounted only when the bounded transition journal proves the exact path identity chain; timing overlap alone
 * is never attribution.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import {
	hostExplainsFileChange,
	hostFileIdentity,
	hostWatchedPathIdentity,
} from "../../utils/host-write-transition.ts";
import {
	AGENT_ROOT_DIRECTORY_NAMES,
	AGENT_ROOT_FILE_NAMES,
	BOTS_DIR_NAME,
	COLLABORATION_DIR_NAME,
	configFile,
	HARNESS_LOG_ROOT_NAME,
	hostTransitionsFile,
	remoteDir,
} from "../agent-paths.ts";
import { quotedSpan } from "../util/bounded-line.ts";
import type { WorkerHostFinding } from "./contracts.ts";
import { hostFinding } from "./host-findings.ts";
import { getHarnessWriteProtectedPaths, projectLaneSettingsPath } from "./lane-private-paths.ts";

/**
 * The link's files a process tool could silently rewrite: this machine's identity, the hub's config, every joined
 * machine's secret, the joins and the link settings. Fingerprinted by name, so the churn inside `remote/` is not.
 */
const WATCHED_REMOTE_FILE_NAMES: readonly string[] = [
	"identity.json",
	"machines.json",
	"joins.json",
	"settings.json",
	"hub.json",
];

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
	"channels",
	// A bot's home (profile, session files, host lock) is written by the host while a bot runs.
	BOTS_DIR_NAME,
	// The link's directory is watched file by file (see WATCHED_REMOTE_FILE_NAMES): its job stores, chats, host lock and
	// link state churn while any lane runs.
	"remote",
	// The harness's own log and the collaboration backend's managed config are written by the host while any lane runs.
	HARNESS_LOG_ROOT_NAME,
	COLLABORATION_DIR_NAME,
	"auth.json",
	"MEMORY.md",
	"USER.md",
]);

const DEFAULT_MAX_ENTRIES = 2_048;
const DEFAULT_MAX_DEPTH = 8;
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
	const linkFiles = WATCHED_REMOTE_FILE_NAMES.map((name) => path.join(remoteDir(agentDir), name));
	return [...getHarnessWriteProtectedPaths(cwd, agentDir).filter((entry) => !excluded.has(entry)), ...linkFiles];
}

export interface ProtectedPathFinding {
	/** Worker the finding is attributed to (observed while this worker's command or run was in progress). */
	readonly workerId: string;
	readonly path: string;
	/** Fingerprint before: `absent`, exact watched file/directory identity, or symlink identity and target. */
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
	/**
	 * Files the host writes and explains through its journal (`hostJournal`): their fingerprint is the exact identity of the
	 * content, and a change is the host's when the journal holds the chain of host writes that produced it.
	 */
	hostExplained?: readonly string[];
	hostJournal?: string;
}

/** The host-explained files and the journal for a session's watch: settings, and the remote link's files. */
export function protectedPathHostOptions(
	cwd: string,
	agentDir: string,
): { hostExplained: readonly string[]; hostJournal: string } {
	return {
		hostExplained: [
			configFile(agentDir, "settings.json"),
			projectLaneSettingsPath(cwd),
			...WATCHED_REMOTE_FILE_NAMES.map((name) => path.join(remoteDir(agentDir), name)),
		],
		hostJournal: hostTransitionsFile(agentDir),
	};
}

type Fingerprints = Map<string, string>;

function fingerprintOf(target: string, explained: ReadonlySet<string>): string {
	if (explained.has(path.resolve(target))) {
		const exact = hostFileIdentity(target);
		if (exact !== undefined) return exact;
	}
	return hostWatchedPathIdentity(target) ?? "absent";
}

/** Bounded, deterministic depth-first fingerprint of every watched root. Returns whether the bound cut it short. */
function fingerprint(
	roots: readonly string[],
	maxEntries: number,
	maxDepth: number,
	explained: ReadonlySet<string>,
): { entries: Fingerprints; truncated: boolean } {
	const entries: Fingerprints = new Map();
	let truncated = false;
	const visit = (target: string, depth: number): void => {
		if (entries.size >= maxEntries) {
			truncated = true;
			return;
		}
		const print = fingerprintOf(target, explained);
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
	private readonly options: Required<
		Omit<ProtectedPathWatchOptions, "workerId" | "paths" | "hostExplained" | "hostJournal">
	> &
		Pick<ProtectedPathWatchOptions, "workerId" | "paths" | "hostJournal">;
	private readonly explained: ReadonlySet<string>;
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
			hostJournal: options.hostJournal,
		};
		this.explained = new Set((options.hostExplained ?? []).map((entry) => path.resolve(entry)));
	}

	private snapshot(): Fingerprints {
		const { entries, truncated } = fingerprint(
			this.options.paths,
			this.options.maxEntries,
			this.options.maxDepth,
			this.explained,
		);
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
						if (!this.hostExplains(change, startedAt, endedAt)) this.record(change, "command");
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
					if (!alreadyReported.has(change.path) && !this.hostExplains(change, this.runBaselineAt, endedAt)) {
						this.record(change, "run");
					}
				}
			}
		} catch {
			// See guard(): unreadable paths are skipped, never raised.
		}
		return this.recorded;
	}

	/** A change is host-owned only when the exact journal chain explains this path's observed identities. */
	private hostExplains(change: { path: string; before: string; after: string }, from: number, to: number): boolean {
		return hostExplainsFileChange(change.path, change.before, change.after, from, to, this.options.hostJournal);
	}

	/** Run the end-of-run comparison, then return the host findings for everything recorded. */
	finishFindings(): WorkerHostFinding[] {
		this.finish();
		return this.findings();
	}

	/**
	 * Host findings for the changes so far, one per change plus one disclosure finding when the finding bound cut it
	 * short. Each renders a line that fits a claim blocker (a longer line would be dropped by claim normalization).
	 */
	findings(): WorkerHostFinding[] {
		const findings = this.recorded.map((finding) =>
			hostFinding(
				"protected_path",
				`${quotedSpan(finding.path)} (${finding.before} -> ${finding.after}) changed while worker ${finding.workerId}'s ${finding.scope === "command" ? "command was running" : "run was in progress"}. A process tool can write harness files the structural write tool refuses: review it and revert it if unintended. Not proof of authorship; the root or another worker may also have written.`,
			),
		);
		if (this.omitted > 0) {
			findings.push(hostFinding("protected_path", `${this.omitted} further protected-path change(s) not listed.`));
		}
		return findings;
	}

	/** True when the entry or depth bound cut a snapshot short, so part of the set was not fingerprinted. */
	get truncated(): boolean {
		return this.truncatedWatch;
	}
}
