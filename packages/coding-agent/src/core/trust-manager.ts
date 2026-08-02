import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { stateFile } from "./agent-paths.ts";
import { isWorkerSession } from "./session-role.ts";
import { acquireFileLockSync, LOW_LATENCY_FILE_LOCK_OPTIONS, writeFileAtomicSync } from "./util/atomic-file.ts";

export type ProjectTrustDecision = boolean | null;

type TrustFile = Record<string, boolean | null | undefined>;

const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD", "GEMINI.md", "GEMINI.MD"];

function normalizeCwd(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

function readTrustFile(path: string): TrustFile | undefined {
	if (!existsSync(path)) {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== true && value !== false && value !== null) {
			throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		data[key] = value;
	}
	return data;
}

function writeTrustFile(path: string, data: TrustFile): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value === true || value === false || value === null) {
			sorted[key] = value;
		}
	}
	writeFileAtomicSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

function withTrustFileLock<T>(path: string, fn: () => T): T {
	const release = acquireFileLockSync(path, LOW_LATENCY_FILE_LOCK_OPTIONS);
	try {
		return fn();
	} finally {
		release();
	}
}

export function hasProjectTrustInputs(cwd: string): boolean {
	let currentDir = resolvePath(cwd);
	if (existsSync(join(currentDir, CONFIG_DIR_NAME))) {
		return true;
	}

	const root = resolve("/");
	while (true) {
		for (const filename of CONTEXT_FILE_NAMES) {
			if (existsSync(join(currentDir, filename))) {
				return true;
			}
		}
		if (existsSync(join(currentDir, ".agents", "skills"))) {
			return true;
		}

		if (currentDir === root) {
			return false;
		}

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

export class ProjectTrustStore {
	private trustPath: string;
	private readonly readOnly: boolean;

	constructor(agentDir: string, options?: { readOnly?: boolean }) {
		// Machine-persisted trust decisions -- state/, not the agentDir root.
		this.trustPath = stateFile(resolvePath(agentDir), "trust.json");
		this.readOnly = options?.readOnly ?? isWorkerSession();
	}

	get(cwd: string): ProjectTrustDecision {
		if (this.readOnly) {
			// Zero-footprint (worker session): a lock-free read -- no lockfile, no state dir ever
			// created just from reading trust. Writers publish by atomic rename, so a worker sees either
			// the prior or next complete generation and still fails malformed input safe to untrusted.
			const data = readTrustFile(this.trustPath);
			if (!data) return null;
			const value = data[normalizeCwd(cwd)];
			return value === true || value === false ? value : null;
		}
		return withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			if (!data) return null;
			const value = data[normalizeCwd(cwd)];
			return value === true || value === false ? value : null;
		});
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		if (this.readOnly) return;
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			if (!data) return;
			const key = normalizeCwd(cwd);
			if (decision === null) {
				delete data[key];
			} else {
				data[key] = decision;
			}
			writeTrustFile(this.trustPath, data);
		});
	}
}
