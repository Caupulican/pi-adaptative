/**
 * Refusal classification of recorded sessions, shared by refusal-census.mjs and mistake-class-census.mjs.
 * Each tool result of a session file is read once: a harness refusal (a failure that is not an operation
 * outcome), an operation outcome (a tool reporting that its own operation ended badly), a Windows shell-contract
 * hit (a bash result matching a named rule), or nothing. The module returns code facts and the caller's
 * matched text; it never writes anything.
 */
import { messageText, parseSessionEntries, toolFailureOf } from "../session-stats-common.mjs";

/** The Windows shell contract, one named rule per alternative. The regex below is exactly their union. */
export const SHELL_CONTRACT_RULES = [
	{ id: "unsupported-flag", pattern: /[a-z]+: unsupported flag/ },
	{ id: "windows-shell-contract", pattern: /not supported by the Windows shell contract/ },
	{ id: "heredoc", pattern: /Heredocs \('<<'\) are not supported/ },
	{ id: "nested-shell", pattern: /Nesting another shell/ },
];

export const SHELL_CONTRACT_RE = new RegExp(SHELL_CONTRACT_RULES.map((rule) => rule.pattern.source).join("|"));

/** Id of the first shell-contract rule the text matches, or undefined. */
export function shellContractRuleOf(text) {
	return SHELL_CONTRACT_RULES.find((rule) => rule.pattern.test(text))?.id;
}

/**
 * Failure code of a harness failure result: the failure ledger record or the directive when present, else the
 * `failure_code` of a legacy `[harness] {json}` text. Undefined when the record carries none.
 */
export function failureCodeOf(message) {
	const details = message.details && typeof message.details === "object" ? message.details : {};
	const code = details.piToolFailureMemory?.failureCode ?? details.piToolFailureDirective?.failureCode;
	if (typeof code === "string") return code;
	const text = messageText(message.content, " ");
	if (!text.startsWith("[harness] ")) return undefined;
	try {
		const legacy = JSON.parse(text.slice("[harness] ".length));
		return typeof legacy.failure_code === "string" ? legacy.failure_code : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The classified tool results of one session file, in transcript order, plus the assistant turn count.
 * Each result has at most one `kind` (`refusal` or `outcome`, undefined when the result is not a failure) and an
 * optional `shellRule`. `matched` is the shell-contract text the rule matched, for the caller's own display only.
 */
export function classifySessionResults(file) {
	const calls = new Map();
	let turns = 0;
	const results = [];
	for (const entry of parseSessionEntries(file)) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			turns += 1;
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part && part.type === "toolCall") calls.set(part.id, { turn: turns, call: part });
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const text = messageText(message.content, " ");
		const known = calls.get(message.toolCallId);
		const tool = known?.call.name ?? message.toolName ?? "?";
		const args = known?.call.arguments ?? {};
		const shellRule = tool === "bash" ? shellContractRuleOf(text) : undefined;
		const failure = toolFailureOf(message);
		if (!shellRule && !failure) continue;
		const result = {
			entryId: entry.id,
			at: entry.timestamp,
			turn: known?.turn ?? turns,
			tool,
			args,
			kind: undefined,
			shellRule,
		};
		if (shellRule) {
			result.command = String(args.command ?? "");
			result.matched = (text.match(SHELL_CONTRACT_RE) ?? [""])[0];
		}
		if (failure) {
			// A tool reporting that its own operation ended badly (a timeout, a non-zero exit) is an outcome the model
			// must act on, not a harness refusal.
			result.kind = message.errorKind === "operation_outcome" ? "outcome" : "refusal";
			result.failureCode = failureCodeOf(message);
			result.diagnostic = failure.diagnostic ?? failure.nextAction ?? text.slice(0, 200);
		}
		results.push(result);
	}
	return { turns, results };
}
