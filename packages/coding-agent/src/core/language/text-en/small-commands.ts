/**
 * The English words of the small commands: the fast mode tiers (`/fast`, `/ultrafast`), the soul file (`/soul`) and the
 * soul review listing, the session's system prompt (`/sysprompt`) and the line that reports a skipped fitness probe. The
 * tier names, the command names and the words the owner wrote into the soul are the same in every language.
 */

export const SMALL_COMMANDS = {
	fastMode: {
		usage: "Usage: /fast [on|off|priority|ultrafast|status]",
		ultrafastUsage: "Usage: /ultrafast [on|off|status]",
		/** The state a tier is in, as the status line says it. */
		on: "on",
		off: "off",
		defaultTier: "default",
		prefix: (statusOnly: boolean, state: string) => (statusOnly ? `Fast mode is ${state}` : `Fast mode ${state}`),
		catalogDefault: (args: { prefix: string; provider: string; tier: string; command: string }) =>
			`${args.prefix}: ${args.provider} requests ${args.tier} processing, the account catalog's default for this model. /${args.command} turns it off.`,
		modelVariant: (prefix: string, fast: boolean) =>
			`${prefix}: Grok requests ${fast ? "Grok 4.7 Fast" : "Grok 4.7 standard"}.`,
		tier: (prefix: string, provider: string, tier: string) => `${prefix}: ${provider} requests ${tier} processing.`,
		ultrafastCost: " Cost uses base rates; Ultrafast pricing is unavailable.",
		/** The provider names the tiers belong to. */
		providerGrok: "Grok",
		providerCodex: "Codex",
		unavailableFor: (model: string, reasonSuffix: string) => `Fast mode is unavailable for ${model}.${reasonSuffix}`,
		unavailableNoModel: "Fast mode is unavailable without an active model.",
	},
	soul: {
		usage: "Usage: /soul [show|review|history|restore <n>]",
		editTitle: "Edit soul (applies from the next session)",
		editCancelled: "Soul edit cancelled.",
		unchanged: "Soul unchanged.",
		notSaved: (reason: string) => `Soul not saved: ${reason}.`,
		saved: (bytes: number) => `Soul saved (${bytes} bytes). It applies from the next session.`,
		missing: (path: string) => `No soul file at ${path}.`,
		historyEmpty: "No soul history yet.",
		historyHeader: "Soul history, newest first (restore with /soul restore <n>):",
		historyEntry: (args: {
			index: number;
			at: string;
			author: string;
			reviewer: string;
			event?: string;
			withheld: boolean;
			bytes: number;
		}) =>
			`${args.index + 1}. ${args.at}  ${args.author}, review ${args.reviewer}${args.event ? `, ${args.event}` : ""}${args.withheld ? ", withheld" : ""}  ${args.bytes} bytes`,
		reviewMissing: (path: string) => `No soul file at ${path}: nothing to review.`,
		reviewUnavailable:
			"System One is not available: the soul was not reviewed. Writes still pass the deterministic screen.",
		restoreUsage: "Usage: /soul restore <n> (the number /soul history shows)",
		notRestored: (reason: string) => `Soul not restored: ${reason}.`,
		restored: (entry: number, bytes: number) =>
			`Soul restored from history entry ${entry} (${bytes} bytes). It applies from the next session.`,
		/** The review listing. A decision keeps its identifier and takes its words from here. */
		reviewFailed: (error: string) => `Soul review failed: ${error}`,
		reviewCannotRun: (error: string) => `Soul review cannot run: ${error}`,
		reviewVerdict: (word: string) => `Soul review: ${word}`,
		reviewUnsettledReason: "the review could not settle the text",
		verdictAllowed: "allowed",
		verdictRejected: "rejected",
		verdictUnsettled: "not settled",
		answerClear: "clear",
		answerFlagged: (clause: string) => `flagged (the text ${clause})`,
		answerUnsettled: "not settled",
		labels: {
			override: "Owner rules",
			authority: "Authority claims",
			covert: "Covert behavior",
			external: "Copied text",
			identity: "Self-description",
		},
		adverseClauses: {
			override: "overrides owner instructions, safety rules or tool gates",
			authority: "grants itself authority",
			covert: "asks for covert or deceptive behavior",
			external: "reads as copied external text",
			identity: "is not a description of who the assistant is",
		},
	},
	systemPrompt: {
		usage: "Usage: /sysprompt [default|reset]",
		noOverride: "No session system prompt override is active.",
		reset: "Session system prompt reset to the generated prompt. The provider prompt cache restarts on the next request.",
		editTitle: "Edit system prompt (this session only)",
		editCancelled: "System prompt edit cancelled.",
		emptyRejected: "An empty system prompt is rejected; use /sysprompt reset to return to the generated prompt.",
		unchanged: "System prompt unchanged.",
		matchesGenerated: "Session system prompt matches the generated prompt; override cleared.",
		overrideSet: (characters: number) =>
			`Session system prompt override set (${characters} chars). It applies from the next request and restarts the provider prompt cache.`,
	},
	modelFitness: {
		skipped: (reason: string) => `Model fitness skipped: ${reason}`,
	},
};
