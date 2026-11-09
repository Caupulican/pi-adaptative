/**
 * Tool runtime settings: tool output reduction, tool execution concurrency, background tool calls, Windows shell
 * options, file encoding rules and the toolkit scripts. Each resolver is pure; the manager passes the layer data it
 * reads.
 */

import { DEFAULT_BACKGROUND_TOOL_CALL_AFTER_MS } from "../background-tool-task-controller.ts";
import type { ToolkitScript } from "../toolkit/script-registry.ts";
import type { FileEncodingRule } from "../tools/file-encoding-metadata.ts";
import {
	DEFAULT_TOOL_EXECUTION_CONCURRENCY,
	MAX_BACKGROUND_TOOL_CALL_AFTER_MS,
	MAX_TOOL_EXECUTION_CONCURRENCY,
	MIN_BACKGROUND_TOOL_CALL_AFTER_MS,
	MIN_TOOL_EXECUTION_CONCURRENCY,
	sanitizeGnuToolsDirSetting,
	sanitizeIntegerSetting,
} from "./settings-rules.ts";
import type {
	ResolvedBackgroundToolSettings,
	ResolvedToolExecutionSettings,
	ResolvedToolOutputSettings,
	ResolvedWindowsShellSettings,
	Settings,
} from "./settings-schema.ts";

/** Tool output reduction and the output level, with the default for each unset or invalid value. */
export function resolveToolOutputSettings(settings: Pick<Settings, "toolOutput">): ResolvedToolOutputSettings {
	const configured = settings.toolOutput ?? {};
	const resolved: ResolvedToolOutputSettings = {
		reduction: configured.reduction === "off" ? "off" : "on",
		level:
			configured.level === "standard" || configured.level === "compact" || configured.level === "auto"
				? configured.level
				: "auto",
	};
	if (typeof configured.rulesFile === "string" && configured.rulesFile.trim().length > 0) {
		resolved.rulesFile = configured.rulesFile.trim();
	}
	return resolved;
}

/** Tool execution concurrency, clamped to its range. */
export function resolveToolExecutionSettings(settings: Pick<Settings, "toolExecution">): ResolvedToolExecutionSettings {
	const configured = settings.toolExecution ?? {};
	return {
		concurrency: sanitizeIntegerSetting(
			configured.concurrency,
			DEFAULT_TOOL_EXECUTION_CONCURRENCY,
			MIN_TOOL_EXECUTION_CONCURRENCY,
			MAX_TOOL_EXECUTION_CONCURRENCY,
		),
	};
}

/** The delay before a tool call moves to the background, clamped to its range. */
export function resolveBackgroundToolSettings(
	settings: Pick<Settings, "backgroundTool">,
): ResolvedBackgroundToolSettings {
	const configured = settings.backgroundTool ?? {};
	return {
		callAfterMs: sanitizeIntegerSetting(
			configured.callAfterMs,
			DEFAULT_BACKGROUND_TOOL_CALL_AFTER_MS,
			MIN_BACKGROUND_TOOL_CALL_AFTER_MS,
			MAX_BACKGROUND_TOOL_CALL_AFTER_MS,
		),
	};
}

/** Windows shell options: the Python engine switch and the GNU tools directory. */
export function resolveWindowsShellSettings(settings: Pick<Settings, "windowsShell">): ResolvedWindowsShellSettings {
	const configured = settings.windowsShell ?? {};
	return {
		pythonEngine: configured.pythonEngine !== false,
		gnuToolsDir: sanitizeGnuToolsDirSetting(configured.gnuToolsDir),
	};
}

/** The file encoding rules in consultation order: the directory profile first, then project, then global. */
export function resolveFileEncodingRules(layers: ReadonlyArray<Settings>): FileEncodingRule[] {
	const rules: FileEncodingRule[] = [];
	const claimed = new Set<string>();
	for (const layer of layers) {
		const configured = layer.fileEncodings;
		if (!configured || typeof configured !== "object" || Array.isArray(configured)) continue;
		for (const [pattern, value] of Object.entries(configured)) {
			const glob = typeof pattern === "string" ? pattern.trim() : "";
			const encoding = typeof value === "string" ? value.trim() : "";
			if (glob.length === 0 || encoding.length === 0 || claimed.has(glob)) continue;
			claimed.add(glob);
			rules.push({ glob, encoding });
		}
	}
	return rules;
}

/** The toolkit scripts that are well formed: a name, a description, a path and a known runner. */
export function resolveToolkitScripts(settings: Pick<Settings, "toolkit">): ToolkitScript[] {
	const configured = settings.toolkit?.scripts;
	if (!Array.isArray(configured)) return [];
	return configured.filter(
		(script): script is ToolkitScript =>
			Boolean(script) &&
			typeof script.name === "string" &&
			script.name.length > 0 &&
			typeof script.description === "string" &&
			typeof script.path === "string" &&
			(script.runner === "uv" || script.runner === "powershell" || script.runner === "bash"),
	);
}
