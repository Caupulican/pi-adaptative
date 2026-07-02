import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CapabilityEnvelope } from "./contracts.ts";

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
		if (typeof value === "string" && value.length > 0) found.push(value);
	}
	for (const key of PATH_LIST_ARGUMENT_KEYS) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry === "string" && entry.length > 0) found.push(entry);
			}
		}
	}
	return found;
}

function isWithinRoot(target: string, root: string): boolean {
	const relativePath = relative(root, target);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	);
}

/**
 * Deny wins over allow; an empty/absent allow list means "no positive scope restriction"
 * (only denies apply) — mirroring the resource-profile filter semantics.
 */
export function isPathWithinEnvelope(envelope: CapabilityEnvelope, rawPath: string, cwd: string): boolean {
	const target = resolve(cwd, rawPath);
	for (const denied of envelope.deniedPaths ?? []) {
		if (isWithinRoot(target, resolve(cwd, denied))) return false;
	}
	const allowed = envelope.allowedPaths ?? [];
	if (allowed.length === 0) return true;
	return allowed.some((root) => isWithinRoot(target, resolve(cwd, root)));
}

export interface EnvelopeScopedTool {
	name: string;
	execute: (...args: unknown[]) => unknown;
}

/**
 * Wrap a tool so every path-bearing argument is scope-checked when it RUNS. The wrapped tool is
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
			for (const rawPath of extractPathArguments(params)) {
				if (!isPathWithinEnvelope(envelope, rawPath, cwd)) {
					return {
						content: [
							{
								type: "text",
								text: `envelope_path_denied: "${rawPath}" is outside envelope ${envelope.id}'s path scope. The tool was NOT run.`,
							},
						],
						details: { outcome: "envelope_path_denied", tool: tool.name, path: rawPath, envelopeId: envelope.id },
						isError: true,
					};
				}
			}
			return tool.execute(...args);
		},
	};
}
