import { resolve } from "node:path";
import { resolveToolCallPathAccess } from "../tool-capability-policy.ts";
import type { CapabilityEnvelope } from "./contracts.ts";
import { isPathWithinScope, safeRealpathSync } from "./path-scope.ts";

/**
 * Tool-level envelope enforcement (G2 prerequisite for code-writing workers): the capability
 * envelope's `allowedPaths`/`deniedPaths` were previously VALIDATION-ONLY — recorded on the
 * envelope but never checked when a tool actually ran. This module wraps tools so path-bearing
 * arguments are checked AT EXECUTION TIME, structurally refusing out-of-scope paths the same way
 * a failed script can never look like success: the refusal is an isError result with a stable
 * outcome code, never a silent no-op.
 */

const PATH_ARGUMENT_KEYS = ["path", "file_path", "filePath", "cwd", "directory", "dir", "target"] as const;
const PATH_LIST_ARGUMENT_KEYS = ["paths", "files"] as const;

export function extractPathArguments(params: unknown): string[] {
	if (!params || typeof params !== "object") return [];
	const record = params as Record<string, unknown>;
	const found: string[] = [];
	for (const key of PATH_ARGUMENT_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) found.push(value.trim());
	}
	for (const key of PATH_LIST_ARGUMENT_KEYS) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry === "string" && entry.trim()) found.push(entry.trim());
			}
		}
	}
	return found;
}

/** Tool-aware path projection shared by every envelope/gateway enforcement boundary. */
export function extractToolPathArguments(toolName: string, params: unknown): string[] {
	const normalizedToolName = toolName.toLowerCase();
	const paths = extractPathArguments(params);
	if (normalizedToolName === "secret_store" && params && typeof params === "object") {
		const record = params as Record<string, unknown>;
		if (record.action === "migrate" && Array.isArray(record.sources)) {
			for (const source of record.sources) {
				if (!source || typeof source !== "object" || !("path" in source)) continue;
				const sourcePath = source.path;
				if (typeof sourcePath === "string" && sourcePath.trim()) paths.push(sourcePath.trim());
			}
		}
		if (record.action === "discover" && paths.length === 0) paths.push(".");
	}
	if (
		paths.length === 0 &&
		(normalizedToolName === "find" ||
			normalizedToolName === "grep" ||
			normalizedToolName === "ls" ||
			normalizedToolName === "pipeline")
	) {
		paths.push(".");
	}
	return paths;
}

/**
 * Deny wins over allow; an empty/absent allow list means "no positive scope restriction"
 * (only denies apply) — mirroring the resource-profile filter semantics.
 *
 * Both the target and every scope root are resolved through the real filesystem
 * (symlinks expanded in the existing prefix) before comparison: a pre-existing symlink
 * under an allowed root cannot smuggle a write outside the scope, and a shortcut into a
 * denied subtree is still denied. An unresolvable target fails closed.
 */
export function isPathWithinEnvelope(envelope: CapabilityEnvelope, rawPath: string, cwd: string): boolean {
	const lexicalTarget = resolve(cwd, rawPath);
	const allowed = envelope.allowedPaths ?? [];
	if (allowed.length > 0) {
		const couldBeAllowed = allowed.some((root) => {
			const lexicalRoot = resolve(cwd, root);
			if (isPathWithinScope(lexicalTarget, lexicalRoot)) return true;
			try {
				return isPathWithinScope(lexicalTarget, safeRealpathSync(lexicalRoot));
			} catch {
				return false;
			}
		});
		if (!couldBeAllowed) return false;
	}
	let target: string;
	try {
		target = safeRealpathSync(lexicalTarget);
	} catch {
		return false;
	}
	for (const denied of envelope.deniedPaths ?? []) {
		try {
			if (isPathWithinScope(target, safeRealpathSync(resolve(cwd, denied)))) return false;
		} catch {
			// Mirror checkPathScope: an unresolvable deny root cannot match anything.
		}
	}
	if (allowed.length === 0) return true;
	return allowed.some((root) => {
		try {
			return isPathWithinScope(target, safeRealpathSync(resolve(cwd, root)));
		} catch {
			return false;
		}
	});
}

export interface EnvelopeScopedTool {
	name: string;
	execute: (...args: unknown[]) => unknown;
}

/**
 * Wrap a tool so path-bearing arguments are scope-checked when it RUNS, consulting canonical
 * tool capability policy so only tools whose policy declares path-scope access
 * (resolveToolCallPathAccess !== "none") are checked against envelope boundaries. The wrapped tool is
 * shape-identical; params are conventionally the second execute argument (toolCallId, params, …).
 */
export function wrapToolWithEnvelopeScope<T extends EnvelopeScopedTool>(
	tool: T,
	envelope: CapabilityEnvelope,
	cwd: string,
): T {
	return {
		...tool,
		execute: (...args: unknown[]) => {
			const params = args[1];
			const pathAccess = resolveToolCallPathAccess(envelope.capabilities, tool.name, params);
			if (pathAccess !== "none") {
				for (const rawPath of extractToolPathArguments(tool.name, params)) {
					if (!isPathWithinEnvelope(envelope, rawPath, cwd)) {
						return {
							content: [
								{
									type: "text",
									text: `envelope_path_denied: "${rawPath}" is outside envelope ${envelope.id}'s path scope. The tool was NOT run.`,
								},
							],
							details: {
								outcome: "envelope_path_denied",
								tool: tool.name,
								path: rawPath,
								envelopeId: envelope.id,
							},
							isError: true,
						};
					}
				}
			}
			return tool.execute(...args);
		},
	};
}
