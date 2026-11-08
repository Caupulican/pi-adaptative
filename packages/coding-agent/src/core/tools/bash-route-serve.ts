import { stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { harnessLog } from "../../kernel/harness-log.ts";
import { type BashRoute, routeBashCommand } from "./bash-route.ts";
import { classifyCommandFamily } from "./command-family.ts";
import { withExclusiveMutationBarrier } from "./file-mutation-queue.ts";
import { createReadTool } from "./read.ts";
import type { ReadToolDetails } from "./schemas/read.ts";
import { isPiSessionJsonlPath } from "./session-transcript-read.ts";

export interface BashRouteCall {
	command: string;
	/** The directory the shell would run the command in; relative operands resolve from here. */
	shellCwd: string;
	toolCallId: string;
	signal?: AbortSignal | undefined;
	/** The call's mutation-lock identity: a served read orders behind earlier edits exactly like a shell run. */
	mutationScope?: string | undefined;
	mutationAnnouncer?: string | undefined;
}

/** The text a routed command returns, or undefined when the shell must run the command itself. */
export type BashRouteServer = (call: BashRouteCall) => Promise<string | undefined>;

/**
 * The read tool's answer for a routed command, or undefined when the read tool is not a faithful
 * stand-in for the shell on this path: the target is not the kind of file system object the form
 * names (a directory for `cat`, a device or FIFO, a file for `ls`), the read tool refuses or fails
 * (missing, unreadable, past the end of the file), the answer is not plain text (an image), the
 * session-transcript projection would replace the bytes, or the decoded text shows the file is not
 * text. In each of those the shell runs the command unchanged and its own output and exit code stand.
 */
async function readFromReadTool(
	route: Exclude<BashRoute, { kind: "shell" }>,
	readTool: ReturnType<typeof createReadTool>,
	toolCallId: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	try {
		const stats = await fsStat(route.path);
		if (route.kind === "list" ? !stats.isDirectory() : !stats.isFile()) return undefined;
		if (route.kind === "read" && isPiSessionJsonlPath(route.path, join(getAgentDir(), "sessions"))) return undefined;
		const params =
			route.kind === "list"
				? { path: route.path }
				: { path: route.path, offset: route.offset, limit: route.limit, tail: route.tail };
		const result = await readTool.execute(toolCallId, params, signal);
		// The read tool caps a listing; a capped listing is not what `ls` prints, so the shell answers.
		const directory = (result.details as ReadToolDetails | undefined)?.directory;
		if (directory && directory.shown < directory.entries) return undefined;
		const text: string[] = [];
		for (const part of result.content) {
			if (part.type !== "text") return undefined;
			text.push(part.text);
		}
		const joined = text.join("\n");
		return joined.includes("\u0000") || joined.includes("�") ? undefined : joined;
	} catch {
		return undefined;
	}
}

/** What the listing is not, in plain words, so the reader is not misled about the format `ls` would have printed. */
function listingNote(route: Exclude<BashRoute, { kind: "shell" }>): string {
	return route.kind === "list" ? "; hidden entries are included, directories come first, sizes shown" : "";
}

/**
 * The route stage of the bash tool. It runs after every guard that admits a bash call (they wrap the
 * tool, so a call reaches `execute` only once they admitted the command text exactly as they would
 * for the shell run) and before a shell is spawned. A recognised read or listing is answered by the
 * read tool's own implementation, with the trailing line naming the route; everything else, and any
 * routed form the read tool cannot answer faithfully, returns undefined for the caller to run.
 */
export function createBashRouteServer(cwd: string): BashRouteServer {
	let readTool: ReturnType<typeof createReadTool> | undefined;
	return async (call) => {
		const route = routeBashCommand(call.command, call.shellCwd);
		if (route.kind === "shell") {
			harnessLog.trace("tools", "bash command passed to the shell", () => ({
				routeId: route.routeId,
				commandClass: classifyCommandFamily(call.command).family,
			}));
			return undefined;
		}
		readTool ??= createReadTool(cwd);
		const served = readTool;
		const text = await withExclusiveMutationBarrier(
			() => readFromReadTool(route, served, call.toolCallId, call.signal),
			{
				signal: call.signal,
				holdId: call.toolCallId,
				...(call.mutationScope !== undefined ? { scope: call.mutationScope } : {}),
				...(call.mutationAnnouncer !== undefined ? { announcer: call.mutationAnnouncer } : {}),
			},
		);
		if (text === undefined) {
			harnessLog.trace("tools", "bash command routed read fell back to the shell", () => ({
				routeId: route.routeId,
				kind: route.kind,
			}));
			return undefined;
		}
		const output = `${text}\n(served by the read tool: ${route.routeId}${listingNote(route)})`;
		harnessLog.debug("tools", "bash command routed", () => ({
			routeId: route.routeId,
			kind: route.kind,
			bytes: Buffer.byteLength(output, "utf8"),
		}));
		return output;
	};
}
