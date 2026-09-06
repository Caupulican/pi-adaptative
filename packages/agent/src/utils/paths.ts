import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { type ExecutionPathFlavor, executionPathApi, resolveExecutionPath } from "../execution-paths.ts";

export {
	assertExecutionAbsolutePath,
	createExecutionContext,
	type ExecutionAttachment,
	type ExecutionContext,
	type ExecutionPathFlavor,
	type ExecutionResourceReference,
	executionPathApi,
	resolveExecutionPath,
	resolveExecutionResource,
} from "../execution-paths.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface PathInputOptions {
	/** Executing backend's dialect. Native CLI callers default to the local platform. */
	flavor?: ExecutionPathFlavor;
	/** Trim leading/trailing whitespace before normalization. */
	trim?: boolean;
	/** Expand leading `~` to a home directory. Defaults to true. */
	expandTilde?: boolean;
	/** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
	homeDir?: string;
	/** Strip a leading `@`, used for CLI @file paths. */
	stripAtPrefix?: boolean;
	/** Normalize unicode space variants to regular spaces. */
	normalizeUnicodeSpaces?: boolean;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	const flavor = options.flavor ?? (process.platform === "win32" ? "win32" : "posix");
	const paths = executionPathApi(flavor);
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}

	if (
		(options.expandTilde ?? true) &&
		(normalized === "~" || normalized.startsWith("~/") || (flavor === "win32" && normalized.startsWith("~\\")))
	) {
		const home = options.homeDir ?? (options.flavor === undefined ? homedir() : undefined);
		if (home === undefined) throw new Error("Explicit execution backend requires an explicit home directory");
		return normalized === "~" ? home : paths.join(home, normalized.slice(2));
	}

	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized, { windows: flavor === "win32" });
	}

	return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir, { ...options, stripAtPrefix: false });
	const flavor = options.flavor ?? (process.platform === "win32" ? "win32" : "posix");
	// Ambient defaults belong only to this native input adapter. Explicit backend contexts
	// must already provide a fully qualified directory and never borrow the operator's drive.
	const cwd = options.flavor === undefined ? executionPathApi(flavor).resolve(normalizedBaseDir) : normalizedBaseDir;
	return resolveExecutionPath(normalized, cwd, flavor);
}
