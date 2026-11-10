/**
 * The English words of the knowledge, taste and memory commands: the listings, the confirmations and the refusals the
 * host writes when the owner reads or corrects what the harness has learned, and the memory drift and history
 * diagnostics. Codes the data holds, such as a record's kind, basis or action, are shown as they are.
 */

export const KNOWLEDGE_COMMANDS = {
	knowledge: {
		validityFuture: (from: string) => `future, from ${from}`,
		validityExpired: (until: string) => `expired ${until}`,
		validityCurrent: "current",
		reachProject: "this project",
		reachGlobal: "global",
		ownerCommand: "owner command",
		ownerMessage: "owner message",
		revision: (revision: number) => `revision ${revision}`,
		shortRevision: (revision: number) => `r${revision}`,
		evidenced: (at: string) => `evidenced ${at}`,
		summaryBody: (subject: string, key: string, text: string) => `    ${subject} / ${key}: ${text}`,
		needId: "Name a knowledge record by its id or its first 8 or more characters (see /knowledge list).",
		unknownRecord: (prefix: string) => `No current knowledge record ${prefix} in this scope.`,
		ambiguousRecord: (prefix: string) => `${prefix} matches more than one record; type more of its id.`,
		noMore: "No more accepted knowledge records.",
		none: (filter: string) => `No accepted knowledge records${filter}.`,
		listHead: (revision: number, filter: string) => `Accepted knowledge, revision ${revision}${filter}:`,
		listMore: (query: string) => `More: /knowledge list ${query}`,
		listHint: "/knowledge show <id> for provenance · history <id> · correct <id> <new value> · forget <id>",
		title: (id: string) => `Knowledge ${id}`,
		factLine: (subject: string, key: string) => `  ${subject} / ${key}`,
		value: (text: string) => `  Value: ${text}`,
		evidencedRange: (first: string, last: string) => `  Evidenced: first ${first}, last ${last}`,
		validRange: (from: string, until: string) => `  Valid: from ${from}${until}`,
		validUntilPart: (until: string) => ` until ${until}`,
		evidenceHead: (from: number, to: number, total: number, shortId: string) =>
			`  Evidence of this revision (${from}-${to} of ${total}; earlier revisions keep theirs in /knowledge history ${shortId}):`,
		citation: (provenance: string, at: string, sessionId: string, sourceId: string, quote: string) =>
			`  - ${provenance}, ${at}, session ${sessionId}, source ${sourceId}\n      "${quote}"`,
		moreEvidence: (shortId: string, offset: number) => `More evidence: /knowledge show ${shortId} ${offset}`,
		historyNone: (shortId: string) => `No earlier revisions of ${shortId}.`,
		historyHead: (shortId: string, subject: string, key: string) =>
			`Revisions of ${shortId} (${subject} / ${key}), newest first:`,
		historyVersion: (revision: number, basis: string, evidencedAt: string, provenance: string, text: string) =>
			`  r${revision} · ${basis} · evidenced ${evidencedAt} · ${provenance}\n    ${text}`,
		historyMore: (shortId: string, revision: number) => `More: /knowledge history ${shortId} ${revision}`,
		commandTooLong: (max: number) => `Nothing changed: the command is longer than ${max} characters.`,
		noConfirmation: "Nothing changed: owner confirmation is unavailable.",
		forgetTitle: "Forget knowledge",
		forgetQuestion: (kind: string, revision: number, fact: string, text: string) =>
			`Forget this ${kind} fact at revision ${revision}? Its value, revision history and names are removed; only owner evidence newer than this request can teach it again.\n${fact}: ${text}`,
		correctTitle: "Correct knowledge",
		correctQuestion: (kind: string, revision: number, fact: string, now: string, next: string) =>
			`Replace the value of this ${kind} fact at revision ${revision}?\n${fact}\nNow: ${now}\nNew: ${next}`,
		notConfirmed: "Nothing changed: the owner did not confirm.",
		held: (reason: string) => `Nothing changed: ${reason}.`,
		forgot: (shortId: string, revision: number) =>
			`Forgot ${shortId} (revision ${revision}). Only newer owner evidence can teach it again.`,
		corrected: (shortId: string, revision: number) =>
			`Corrected ${shortId}: revision ${revision} holds the new value; the previous one stays in its history.`,
		unavailable: "Owner knowledge is available while ICM memory is active in a root session.",
		failed: (error: string) => `Knowledge: ${error}`,
	},
	taste: {
		empty: 'No taste learned yet. Taste is learned from what you state about how you want code and other work written, for example "I prefer early returns over nested conditionals".',
		noMore: "No more taste.",
		basisStated: "stated",
		basisInferred: "inferred",
		sourceCount: (count: number) => `${count} ${count === 1 ? "source" : "sources"}`,
		bullet: (text: string, basis: string, sources: string, lastEvidence: string, shortId: string) =>
			`- ${text} (${basis}, ${sources}, last evidence ${lastEvidence}) \`${shortId}\``,
		title: "# Taste",
		projectHeading: "This project's taste",
		globalHeading: "Global taste",
		exportRelativePath: "Nothing written: a relative path must stay inside the working directory.",
		exported: (target: string) => `Wrote ${target}`,
		exportHeader: (date: string) =>
			`<!-- Generated view of what the harness has learned, ${date}. Edit with /knowledge correct and /knowledge forget, not here. -->`,
		proposalsTitle: "# Taste proposals",
		proposalsIntro:
			"Nothing here is knowledge yet. `/taste accept <id>` states one as your own taste; `/taste reject <id>` drops it for good.",
		noProposals: "No taste proposals are waiting.",
		proposalScopeProject: "This project",
		proposalScopeGlobal: "Global",
		proposalHead: (text: string, shortId: string) => `- ${text} \`${shortId}\``,
		proposalMeta: (scope: string, origin: string, offeredAt: string) =>
			`  ${scope} · from ${origin} · offered ${offeredAt}`,
		proposalEvidence: "  Evidence:",
		needProposalId: "Give the proposal's id: at least eight hex characters.",
		noProposalStartsWith: (token: string) => `No proposal starts with ${token}.`,
		ambiguousProposal: (token: string) => `More than one proposal starts with ${token}; give more characters.`,
		notTasteProposal: (shortId: string) => `Proposal ${shortId} is not a taste proposal; /taste does not decide it.`,
		alreadyDecided: (shortId: string, status: string) => `Proposal ${shortId} was already ${status}.`,
		commandTooLong: (max: number) => `Nothing changed: the command is longer than ${max} characters.`,
		noConfirmation: "Nothing changed: owner confirmation is unavailable.",
		acceptTitle: "Accept taste",
		acceptQuestion: (kind: string, scope: string, text: string) =>
			`State this ${kind} fact as yours, for ${scope}?\n${text}`,
		scopeProject: "this project",
		scopeEveryProject: "every project",
		notConfirmed: "Nothing changed: the owner did not confirm.",
		unchanged: (reason: string) => `Nothing changed: ${reason}`,
		held: (reason: string) => `Nothing changed: ${reason}. The proposal stays pending.`,
		accepted: (proposalId: string, tasteId: string) =>
			`Accepted proposal ${proposalId} as taste ${tasteId}.  /knowledge show ${tasteId}`,
		rejected: (shortId: string) => `Rejected proposal ${shortId}. It will not be proposed again.`,
		unavailable: "Taste is available while ICM memory is active in a root session.",
		failed: (error: string) => `Taste: ${error}`,
		more: (id: string) => `\nMore: /taste ${id}`,
	},
	memory: {
		unavailable: "Managed memory is not available in this session.",
		drifted: (count: number) =>
			`${count} managed memory file${count > 1 ? "s" : ""} drifted — /memory accept <target> adopts the file, /memory restore <target> brings the managed content back`,
		inSync: "Managed memory files are in sync with their managed revisions.",
		managedState: (status: string) => `managed state ${status}`,
		empty: "EMPTY on disk — drifted",
		driftedOne: "drifted (edited outside the managed protocol)",
		inSyncOne: "in sync",
		entryLine: (target: string, label: string, state: string, chars: number, managed: string, path: string) =>
			`- ${target}: ${label} — ${state}; on disk ${chars} chars; ${managed}\n  ${path}`,
		managedChars: (chars: number) => `managed ${chars} chars stored`,
		managedMissing: "managed content not stored",
		historyIndexingError: (at: string, message: string) => `  indexing error detail (${at}): ${message}`,
		historyOldIndexingError: (at: string, message: string) =>
			`  historical indexing error detail, no source failing now (${at}): ${message}`,
		historyTransportStopped: "transport stopped",
		historyUnavailable: "history unavailable",
		historyDetail: (label: string, reason: string) => `  ${label}: ${reason}`,
		historyRetrievalError: (error: string) => `  retrieval error detail: ${error}`,
		historyHierarchyOff: (reason: string) => `  hierarchy not running: ${reason}`,
		historyReadAccess: (reason: string) => `  summary read access detail: ${reason}`,
		historyFailure: (level: number, reason: string, message: string) =>
			`  hierarchy failure (level ${level}, ${reason}): ${message}`,
		historyRecovery: (issue: string) => `  hierarchy recovery: ${issue}`,
		historyFault: (at: string, cause: string) =>
			`  coordinator's latest fault (recorded ${at}, may be over): ${cause}`,
		historyInternalCause: (at: string, cause: string) =>
			`  coordinator's latest internal cause (newest only, recorded ${at}, may be over): ${cause}`,
		historySummariesHeld: (reason: string) => `  model summaries held: ${reason}`,
		historyHeldJob: (hold: string, reason: string) => `  first held job cause${hold}: ${reason}`,
		historyHeldKind: (kind: string) => ` (hold: ${kind})`,
		repairAcknowledge: "Acknowledge the possible loss to repair: /memory history repair-forget I-accept-lost-forgets",
		repeatSessionId: "Repeat the session id to confirm: /memory history forget <session> <session>",
		system: (system: string) => `Memory system: ${system}`,
	},
};
