import { isBunBinary } from "../../config.ts";

/**
 * A JavaScript runtime this process can start for code that is not pi itself: a generated proof script, a
 * repository's own `.mjs` tool. Pi's own commands go through the self-launch target instead.
 *
 * Under node or bun the running executable is that runtime. A Bun-compiled pi binary's executable is pi:
 * `pi -e <script>` parses as `--extension <script>`, and `pi <file.mjs> <args>` becomes a print-mode prompt.
 * Bun runs a standalone executable as the bun CLI when `BUN_BE_BUN=1` is in its environment, which is how the
 * binary's embedded runtime is reached.
 *
 * This is a finite-helper resolution: it names the executable of the running generation, which lives as long as
 * this process does. A command that must outlive the process needs the stable self-launch target.
 */
export interface JavaScriptRuntime {
	readonly executable: string;
	/** Variables the child needs on top of the inherited environment. */
	readonly environment: Readonly<Record<string, string>>;
}

export function getJavaScriptRuntime(): JavaScriptRuntime {
	return { executable: process.execPath, environment: isBunBinary ? { BUN_BE_BUN: "1" } : {} };
}
