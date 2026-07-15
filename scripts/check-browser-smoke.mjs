import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { acquireScriptWorkRun, removeScriptWorkRun } from "./lib/work-directory.mjs";

const workRun = acquireScriptWorkRun("validation", "browser-smoke");
const outputPath = join(workRun.path, "browser-smoke.js");
const errorLogPath = join(workRun.path, "errors.log");

try {
	await build({
		entryPoints: ["scripts/browser-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		outfile: outputPath,
	});
	removeScriptWorkRun(workRun);
	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	workRun.release();
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
