/**
 * Typed path SSOT for everything machine-managed under `<agentDir>` (`~/.pi/agent/` by default,
 * `getAgentDir()` in `../config.ts`). Every writer that persists machine data (stores, caches, managed
 * runtimes/models, cross-process coordination) MUST resolve its path through one of the accessors
 * below instead of hand-rolling `join(agentDir, …)` — that ad-hoc pattern is exactly how root-level
 * stragglers like `trust.json` accumulated, and nothing stopped the next writer from doing it again.
 *
 * Canonical layout:
 * ```
 * <agentDir>/
 *   auth.json settings.json models.json keybindings.json MEMORY.md USER.md SYSTEM.md …   user CONFIG/MEMORY (root, kept)
 *   okf-memory/                                                                            authored memory (root, kept)
 *   skills/ extensions/ prompts/ themes/ profiles/                                        user RESOURCES (root, kept)
 *     profiles/directories/<workspace-hash>/settings.json                                 directory overlays
 *   state/     durable machine state (model adaptation/fitness, tool performance,
 *              learning observations, trust decisions, config backups, …)                 -- stateDir/stateFile
 *   cache/     rebuildable, safe to delete (tool-path probes, jiti transform cache, uv)    -- cacheDir/cacheFile
 *   work/      transient/scratch, delegated to work-directory.ts (tenant/run/lease),
 *              including context/sessions/<session-id>/{gc,artifacts}                     -- re-exported below
 *   runtimes/<kind>  models/<kind>                                                         -- runtimesDir/modelsDir
 *   npm/ git/ sessions/                                                                    -- npmDir/gitDir/sessionsDir
 *   state/orchestration/sessions/<session-key>/                                             -- one foreground-session-owned
 *                                                                                            control-plane bundle
 *     worker-context-forks/<identity-digest>-<content-digest>.json                         -- immutable birth snapshots
 *   worktrees/<repo-slug>/<laneKey>   durable lane checkouts (core/worktree-sync)           -- worktreesDir
 * ```
 *
 * Every accessor takes `agentDir` as an explicit, required first argument -- deliberately mirroring
 * `work-directory.ts`'s existing `getWorkRoot(agentDir)` convention rather than defaulting to
 * `getAgentDir()` internally. Several real callers (stores' `forAgentDir`, test harnesses with a temp
 * agentDir) build paths for a NON-default agentDir; a hidden default would silently resolve the wrong
 * root for those callers instead of failing loudly. Callers operating on the process-wide default pass
 * `getAgentDir()` explicitly at the call site.
 *
 * These accessors are pure path builders -- no directory creation, no I/O. Every existing writer
 * already creates its parent directory at write time (see `util/atomic-file.ts`'s
 * `mkdirSync(dirname(filePath), { recursive: true })`), so duplicating that here would be redundant
 * and would blur the "pure function" contract readers rely on.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	acquireWorkRun,
	assertPortablePathSegment,
	boundedWorkRetention,
	createWorkRunId,
	getProcessWorkRun,
	getWorkRoot,
	getWorkRunDir,
	getWorkTenantDir,
	hasActiveWorkRunLease,
	pruneWorkTenant,
} from "../utils/work-directory.ts";
import { getReloadCoordinationDir } from "./reload-blockers.ts";
import { requireBoundedTrimmedText } from "./util/bounded-value.ts";

/** Root entries reserved for user-authored configuration and memory. */
export const AGENT_ROOT_FILE_NAMES = [
	"auth.json",
	"settings.json",
	"models.json",
	"keybindings.json",
	"MEMORY.md",
	"USER.md",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

/** Root entries reserved for user resources and machine-managed storage classes. */
export const AGENT_ROOT_DIRECTORY_NAMES = [
	"okf-memory",
	"skills",
	"extensions",
	"prompts",
	"themes",
	"profiles",
	"pipelines",
	"state",
	"cache",
	"bin",
	"work",
	"runtimes",
	"models",
	"sessions",
	"npm",
	"git",
	"worktrees",
] as const;

const AGENT_ROOT_ENTRY_NAMES = new Set<string>([...AGENT_ROOT_FILE_NAMES, ...AGENT_ROOT_DIRECTORY_NAMES]);

export function isCanonicalAgentRootEntry(name: string): boolean {
	return AGENT_ROOT_ENTRY_NAMES.has(name);
}

/** `<agentDir>/<name>` -- a root-level user config/memory file (auth.json, settings.json, MEMORY.md, …). */
export function configFile(agentDir: string, name: string): string {
	return join(agentDir, name);
}

/**
 * `<agentDir>/memory/projects/<project-key>` -- the project's hot memory (its own MEMORY.md), keyed
 * like OKF so one derivation names both. The global MEMORY.md keeps facts true in any task.
 */
export function projectMemoryDir(agentDir: string, projectKey: string): string {
	if (!/^[a-f0-9]{16}$/i.test(projectKey)) {
		throw new TypeError("Project memory key must be a 16-character hexadecimal digest.");
	}
	return join(agentDir, "memory", "projects", projectKey.toLowerCase());
}

/** `<agentDir>/memory/projects` -- every project's hot memory; private to the main lane. */
export function projectMemoryRoot(agentDir: string): string {
	return join(agentDir, "memory", "projects");
}

/** Managed-state sidecar for a project's MEMORY.md (drift detection, like the global files). */
export function managedProjectMemoryStateFile(agentDir: string, projectKey: string): string {
	return stateFile(
		agentDir,
		"memory",
		"file-store",
		"projects",
		`${projectKey.toLowerCase()}.MEMORY.md.pi-managed.json`,
	);
}

/** `<agentDir>/okf-memory` -- user-authored durable OKF memory documents. */
export function okfMemoryDir(agentDir: string): string {
	return join(agentDir, "okf-memory");
}

/** `<agentDir>/okf-memory/projects/<project-key>` -- managed project-isolated OKF records. */
export function okfProjectMemoryDir(agentDir: string, projectKey: string): string {
	if (!/^[a-f0-9]{16}$/i.test(projectKey)) {
		throw new TypeError("OKF project key must be a 16-character hexadecimal digest.");
	}
	return join(okfMemoryDir(agentDir), "projects", projectKey.toLowerCase());
}

/** `<agentDir>/state` -- durable machine-managed state. Deleting it loses real history, not just cache. */
export function stateDir(agentDir: string): string {
	return join(agentDir, "state");
}

/** `<agentDir>/state/<segments…>` */
export function stateFile(agentDir: string, ...segments: string[]): string {
	return join(stateDir(agentDir), ...segments);
}

export type ManagedMemoryFileName = "MEMORY.md" | "USER.md";

/** `<agentDir>/state/memory/file-store/<name>.pi-managed.json` -- file-store ownership metadata. */
export function managedMemoryStateFile(agentDir: string, name: ManagedMemoryFileName): string {
	if (name !== "MEMORY.md" && name !== "USER.md") {
		throw new TypeError(`Unsupported managed memory file name: ${name}`);
	}
	return stateFile(agentDir, "memory", "file-store", `${name}.pi-managed.json`);
}

/** `<agentDir>/state/attachments` -- bounded, session-keyed clipboard image attachments. */
export function attachmentsDir(agentDir: string): string {
	return stateFile(agentDir, "attachments");
}

/** Retired local-secret state root. Current credential storage is provider-backed and never writes here. */
export function secretsDir(agentDir: string): string {
	return stateFile(agentDir, "secrets");
}

/** Retired local vault path retained only so model-facing file access stays denied. */
export function secretVaultFile(agentDir: string): string {
	return join(secretsDir(agentDir), "vault.json");
}

/** Retired plaintext materialization root retained only so model-facing file access stays denied. */
export function managedSecretEnvDir(agentDir: string): string {
	return join(secretsDir(agentDir), "materialized");
}

/** Cross-process lock target for Bitwarden Secrets Manager profile mutations and bootstrap. */
export function bitwardenSecretsManagerCoordinationFile(agentDir: string): string {
	return join(secretsDir(agentDir), "bitwarden-secrets-manager");
}

/** `<agentDir>/state/extensions/<namespace>` -- durable state owned by one extension. */
export function extensionStateDir(agentDir: string, namespace: string): string {
	assertPortablePathSegment("Extension namespace", namespace);
	return stateFile(agentDir, "extensions", namespace);
}

/** `<agentDir>/state/backups/config` -- explicit user-requested configuration snapshots. */
export function configBackupsDir(agentDir: string): string {
	return stateFile(agentDir, "backups", "config");
}

/** `<agentDir>/cache` -- rebuildable; safe to delete (the next run just re-probes/recomputes). */
export function cacheDir(agentDir: string): string {
	return join(agentDir, "cache");
}

/** `<agentDir>/cache/<segments…>` */
export function cacheFile(agentDir: string, ...segments: string[]): string {
	return join(cacheDir(agentDir), ...segments);
}

/** `<agentDir>/cache/extensions/<namespace>` -- rebuildable cache owned by one extension. */
export function extensionCacheDir(agentDir: string, namespace: string): string {
	assertPortablePathSegment("Extension namespace", namespace);
	return cacheFile(agentDir, "extensions", namespace);
}

/** `<agentDir>/bin` -- managed executable helpers (fd, rg, jq, uv). */
export function binDir(agentDir: string): string {
	return join(agentDir, "bin");
}

/** `<agentDir>/runtimes/<kind>` -- a managed runtime install (ollama, python, prism-llamacpp, needle, …). */
export function runtimesDir(kind: string, agentDir: string): string {
	return join(agentDir, "runtimes", kind);
}

/** `<agentDir>/models/<kind>` -- downloaded model weights, grouped by provider/runtime. */
export function modelsDir(kind: string, agentDir: string): string {
	return join(agentDir, "models", kind);
}

/** `<agentDir>/sessions` -- session transcript storage (large, established; not a "loose file"). */
export function sessionsDir(agentDir: string): string {
	return join(agentDir, "sessions");
}

function orchestrationSessionKey(parentSessionId: string): string {
	const normalized = requireBoundedTrimmedText(parentSessionId, 512, "Parent session id");
	const readable =
		encodeURIComponent(normalized)
			.replaceAll("%", "_")
			// encodeURIComponent deliberately leaves `*` unescaped, but Windows forbids it in paths.
			// Restrict the readable prefix to a portable ASCII subset; the digest retains exact identity.
			.replaceAll(/[^a-zA-Z0-9._~-]/g, "_")
			.slice(0, 80) || "session";
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	return `${readable}-${digest}`;
}

/**
 * `<agentDir>/state/orchestration/sessions/<session-key>` -- the one durable control-plane
 * bundle owned by a foreground session. Event state, worker mailboxes, mutation journals, and
 * worker transcripts must stay beneath this boundary so explicit session deletion can remove
 * exactly its companion artifacts without scanning global state.
 */
export function orchestrationSessionsDir(agentDir: string): string {
	return stateFile(agentDir, "orchestration", "sessions");
}

/**
 * `<agentDir>/state/orchestration/sessions/<session-key>` -- the one durable control-plane
 * bundle owned by a foreground session.
 */
export function orchestrationSessionDir(agentDir: string, parentSessionId: string): string {
	return join(orchestrationSessionsDir(agentDir), orchestrationSessionKey(parentSessionId));
}

/** `<orchestrationSessionDir>/events` -- append-only event tail, snapshot, cursor, and idempotency state. */
export function orchestrationEventStoreDir(agentDir: string, parentSessionId: string): string {
	return join(orchestrationSessionDir(agentDir, parentSessionId), "events");
}

/**
 * `<orchestrationSessionDir>/worker-conversations` -- durable Pi worker transcripts owned by one
 * foreground session. Worker conversations remain in SessionManager's established JSONL format,
 * but are intentionally outside the foreground session picker namespace.
 */
export function workerConversationSessionsDir(agentDir: string, parentSessionId: string): string {
	return join(orchestrationSessionDir(agentDir, parentSessionId), "worker-conversations");
}

/** `<orchestrationSessionDir>/worker-context-forks` -- immutable sanitized worker birth snapshots. */
export function workerContextForksDir(agentDir: string, parentSessionId: string): string {
	return join(orchestrationSessionDir(agentDir, parentSessionId), "worker-context-forks");
}

/**
 * `<workerContextForksDir>/<identity-digest>-<content-digest>.json` -- one immutable,
 * content-addressed sanitized worker birth snapshot.
 */
export function workerContextForkFile(
	agentDir: string,
	parentSessionId: string,
	identityDigest: string,
	contentDigest: string,
): string {
	if (!/^[a-f0-9]{64}$/i.test(identityDigest) || !/^[a-f0-9]{64}$/i.test(contentDigest)) {
		throw new TypeError("Worker context fork identities must be hexadecimal SHA-256 digests.");
	}
	return join(
		workerContextForksDir(agentDir, parentSessionId),
		`${identityDigest.toLowerCase()}-${contentDigest.toLowerCase()}.json`,
	);
}

/** `<orchestrationSessionDir>/worker-output-artifacts` -- lossless terminal worker reports. */
export function workerOutputArtifactsDir(agentDir: string, parentSessionId: string): string {
	return join(orchestrationSessionDir(agentDir, parentSessionId), "worker-output-artifacts");
}

/** One immutable, content-addressed terminal worker report. */
export function workerTerminalOutputArtifactFile(
	agentDir: string,
	parentSessionId: string,
	attemptDigest: string,
	contentDigest: string,
): string {
	if (!/^[a-f0-9]{64}$/i.test(attemptDigest) || !/^[a-f0-9]{64}$/i.test(contentDigest)) {
		throw new TypeError("Worker output artifact identities must be hexadecimal SHA-256 digests.");
	}
	return join(
		workerOutputArtifactsDir(agentDir, parentSessionId),
		`${attemptDigest.toLowerCase()}-${contentDigest.toLowerCase()}.txt`,
	);
}

/**
 * `<orchestrationSessionDir>/worker-mailboxes/<scope-digest>.json` -- durable bounded control
 * messages for one logical worker. Identity stays hashed so neither agent ids nor project paths
 * become path segments.
 */
export function workerAgentMailboxFile(agentDir: string, parentSessionId: string, scopeDigest: string): string {
	if (!/^[a-f0-9]{32,64}$/i.test(scopeDigest)) {
		throw new TypeError("Worker agent mailbox scope digest must be a hexadecimal SHA-256 prefix.");
	}
	return join(
		orchestrationSessionDir(agentDir, parentSessionId),
		"worker-mailboxes",
		`${scopeDigest.toLowerCase()}.json`,
	);
}

/**
 * `<orchestrationSessionDir>/session-root-mailbox.json` -- the bounded durable reply inbox for the
 * owning foreground session. The parent session identity is already encoded in the enclosing
 * session directory, so this fixed filename cannot collide with another session root.
 */
export function sessionRootMailboxFile(agentDir: string, parentSessionId: string): string {
	return join(orchestrationSessionDir(agentDir, parentSessionId), "session-root-mailbox.json");
}

/**
 * `<orchestrationSessionDir>/worker-actions/<scope-digest>.json` -- durable, bounded mutation
 * intents and receipts for one fenced worker attempt. The opaque digest intentionally keeps task
 * identifiers out of filesystem path segments and works on Windows and WSL.
 */
export function workerActionJournalFile(agentDir: string, parentSessionId: string, scopeDigest: string): string {
	if (!/^[a-f0-9]{32,64}$/i.test(scopeDigest)) {
		throw new TypeError("Worker action journal scope digest must be a hexadecimal SHA-256 prefix.");
	}
	return join(
		orchestrationSessionDir(agentDir, parentSessionId),
		"worker-actions",
		`${scopeDigest.toLowerCase()}.json`,
	);
}

/** `<agentDir>/npm` -- managed npm package installs. */
export function npmDir(agentDir: string): string {
	return join(agentDir, "npm");
}

/**
 * `<agentDir>/worktrees` -- lane worktree checkouts for the worktree-sync subsystem
 * (`core/worktree-sync/`), grouped as `worktrees/<repo-slug>/<laneKey>`. These hold REAL
 * uncommitted agent work, so they are durable like `state/` -- never under transient `work/`,
 * whose retention would silently eat in-progress code.
 */
export function worktreesDir(agentDir: string): string {
	return join(agentDir, "worktrees");
}

/** `<agentDir>/git` -- managed git-sourced package installs. */
export function gitDir(agentDir: string): string {
	return join(agentDir, "git");
}

export type AgentResourceKind = "skills" | "prompts" | "themes" | "extensions" | "profiles" | "pipelines";

/** `<agentDir>/<kind>` -- a user-managed resource directory. Root, kept: moving it breaks users. */
export function resourceDir(kind: AgentResourceKind, agentDir: string): string {
	return join(agentDir, kind);
}

/** `<agentDir>/profiles/directories` -- durable per-directory resource-profile overlays. */
export function directoryProfilesDir(agentDir: string): string {
	return join(resourceDir("profiles", agentDir), "directories");
}

/**
 * `work/` is a mature transient/scratch root with its own tenant/run/lease/retention machinery
 * (`utils/work-directory.ts`). The SSOT delegates to it wholesale instead of reimplementing -- these
 * are straight re-exports so every category (state/cache/work/runtimes/models/…) is reachable from one
 * module without duplicating `work-directory.ts`'s logic.
 */
export {
	getWorkRoot,
	assertPortablePathSegment,
	boundedWorkRetention,
	getWorkTenantDir,
	getWorkRunDir,
	getProcessWorkRun,
	hasActiveWorkRunLease,
	acquireWorkRun,
	createWorkRunId,
	pruneWorkTenant,
};
export type { AcquireWorkRunOptions, WorkRetentionOptions, WorkRunLease } from "../utils/work-directory.ts";

/**
 * `work/reload-coordination` -- cross-process reload/live-op coordination state. Already correctly
 * work-scoped (defined in `reload-blockers.ts`, its natural home given the surrounding reload-gate
 * logic there); re-exported here under the taxonomy's canonical name for SSOT discoverability.
 */
export const reloadCoordinationDir = getReloadCoordinationDir;
