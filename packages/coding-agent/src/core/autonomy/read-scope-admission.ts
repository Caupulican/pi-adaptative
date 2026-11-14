/**
 * The one admission of a confined read scope: every path a read tool opens (`read`, `ls`, `grep`, `find`, `repo_read` and
 * the git directory it reads; a `lookup` request is admitted as its own tool) must lie inside the holder's read roots and
 * outside its private paths. A worker lane applies it in its tool admission, a session in the tool it runs
 * (`wrapToolWithReadScope`), so the same read gets the same verdict wherever it runs, in every execution mode.
 */

import { toolPathSpellings } from "../../kernel/utils/paths.ts";
import type { HarnessCapability } from "../orchestration/contracts.ts";
import {
	requiredEnvelopeCapabilities,
	resolveToolCallPathAccess,
	type ToolCallFacts,
} from "../tool-capability-policy.ts";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import { type EnvelopeScopedTool, extractToolPathArguments } from "./envelope-enforcement.ts";
import { findRepositoryGitPaths } from "./path-scope.ts";
import { readScopeRefusal, type SessionReadScope } from "./session-read-scope.ts";

/**
 * The first path a read tool opens outside `scope`, with why, naming the `holder` whose scope it is; undefined when every
 * path it opens lies inside. The paths are the tool's own path arguments (a search with none opens `.`), so a read the
 * tool would make is judged.
 */
export function readScopeViolation(
	toolName: string,
	args: unknown,
	facts: ToolCallFacts | undefined,
	capabilities: readonly HarnessCapability[],
	scope: SessionReadScope,
	holder: string,
): string | undefined {
	if (resolveToolCallPathAccess(capabilities, toolName, args, facts) !== "read") return undefined;
	for (const target of extractToolPathArguments(toolName, args)) {
		const refusal = readScopeRefusal(scope, target);
		if (refusal)
			return `${target} is ${refusal === "denied" ? "a private path" : `outside this ${holder}'s read scope`}`;
		// git reads the whole repository it runs in, including a linked worktree's shared common directory.
		if (toolName !== "repo_read") continue;
		for (const spelled of toolPathSpellings(target, scope.cwd) ?? []) {
			for (const gitDir of findRepositoryGitPaths(spelled)?.gitDirs ?? []) {
				const gitRefusal = readScopeRefusal(scope, gitDir);
				if (gitRefusal) return `the repository's git directory ${gitDir} is outside this ${holder}'s read scope`;
			}
		}
	}
	return undefined;
}

/**
 * Wrap a session's tool so a read outside the session's read scope is refused when the tool runs; a tool that reads no
 * path passes through. The call is judged by the tool's own capability policy, in the directory it runs in.
 */
export function wrapToolWithReadScope<T extends EnvelopeScopedTool>(tool: T, scope: SessionReadScope): T {
	return wrapToolExecution(tool, (executor, executionContext) => {
		type Execute = T["execute"];
		const execute = (...args: Parameters<Execute>): ReturnType<Execute> => {
			const violation = readScopeViolation(
				tool.name,
				args[1],
				undefined,
				requiredEnvelopeCapabilities(tool.name, args[1]),
				{ ...scope, cwd: executionContext?.cwd ?? scope.cwd },
				"bot",
			);
			if (violation === undefined) return executor.execute(...args) as ReturnType<Execute>;
			return Promise.resolve({
				content: [
					{
						type: "text",
						text: `Read scope: ${violation}. This bot reads only the directories it was given; tell the owner the path it needs instead of reading it. The tool was NOT run.`,
					},
				],
				details: { outcome: "read_scope_refused", tool: tool.name },
				isError: true,
			}) as ReturnType<Execute>;
		};
		return { ...executor, execute } as T;
	});
}
