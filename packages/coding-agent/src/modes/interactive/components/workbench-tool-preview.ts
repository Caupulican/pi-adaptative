import { sanitizeBinaryOutput } from "@caupulican/pi-agent-core/shell-output";
import { type Component, Text } from "@caupulican/pi-tui";
import { isRecordObject } from "../../../core/util/value-guards.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { renderDiff } from "./diff.ts";

interface PreviewResult {
	isError: boolean;
	content: readonly { type: string; text?: string }[];
	details?: unknown;
}

/** Text-only effect projection; never expands the canonical action or hydrates routine read payloads. */
export function createWorkbenchToolPreview(name: string, args: unknown, result: PreviewResult): Component | undefined {
	if (!result.isError && !["edit", "write", "bash", "python", "shell"].includes(name)) return undefined;
	const parameters = isRecordObject(args) ? args : {};
	const details = isRecordObject(result.details) ? result.details : {};
	const path = typeof parameters.path === "string" ? parameters.path : "";
	let body = "";
	let diff = false;
	if (!result.isError && typeof details.diff === "string") {
		body = details.diff;
		diff = true;
	} else if (!result.isError && name === "write" && typeof parameters.content === "string") {
		body = parameters.content
			.slice(0, 16_384)
			.split("\n", 40)
			.map((line, index) => `+${index + 1} ${line}`)
			.join("\n");
		diff = true;
	} else {
		for (const block of result.content) {
			if (body.length >= 16_384) break;
			if (block.type === "text" && block.text) body += `${block.text.slice(0, 16_384 - body.length)}\n`;
		}
	}
	const bounded = sanitizeBinaryOutput(stripAnsi(body.slice(0, 16_384)))
		.replace(/\r/g, "")
		.split("\n", 40)
		.join("\n");
	const label = sanitizeBinaryOutput(stripAnsi(`${name}${path ? ` · ${path}` : ""}`)).slice(0, 512);
	const failed = result.isError;
	const truncated = body.length > bounded.length + 1;
	let component: Text | undefined;
	return {
		render(width) {
			component ??= new Text(
				theme.fg(failed ? "error" : "accent", `${failed ? "Failed · " : ""}${label}`) +
					(bounded.trim() ? `\n${diff ? renderDiff(bounded) : theme.fg("toolOutput", bounded.trimEnd())}` : "") +
					(truncated ? theme.fg("dim", "\n… full result in transcript") : ""),
				0,
				0,
			);
			return component.render(width);
		},
		invalidate() {
			component = undefined;
		},
	};
}
