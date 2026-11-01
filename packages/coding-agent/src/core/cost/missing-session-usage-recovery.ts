import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import { sessionSemanticUsageOf } from "./semantic-usage-delivery.ts";
import { journalSlotOf, readJournal, sessionJournalPaths } from "./semantic-usage-journal.ts";
import { createSessionManagerLedgerPort, normalizedReport } from "./session-ledger-port.ts";
import { semanticUsageReportOf } from "./usage-records.ts";

/** Recover only an independently identified, never-persisted empty session and its own validated journal. */
export function recoverMissingSessionUsage(args: {
	cwd: string;
	agentDir: string;
	sessionFile: string;
	journalFile: string;
	sessionId: string;
	headerTimestamp: string;
	headerVersion: number;
}): {
	committed: string[];
	unconfirmed: string[];
	journalRemaining: boolean;
	residualSidecars: string[];
	warnings: string[];
} {
	if (
		!isAbsolute(args.sessionFile) ||
		!isAbsolute(args.journalFile) ||
		!isAbsolute(args.cwd) ||
		!args.headerTimestamp ||
		args.headerTimestamp === "unknown"
	)
		throw new Error("Recovery requires absolute paths and an exact original header timestamp");
	const sessionFile = resolve(args.sessionFile);
	const slot = journalSlotOf({
		sessionId: args.sessionId,
		sessionFile,
		headerTimestamp: args.headerTimestamp,
		persisted: true,
	});
	if (!slot || slot.path !== resolve(args.journalFile) || existsSync(sessionFile))
		throw new Error("Recovery identity does not match the missing session and journal paths");
	const document = readJournal(slot);
	if (
		!document ||
		document.sessionFile !== sessionFile ||
		document.headerTimestamp !== args.headerTimestamp ||
		document.conflicts.length ||
		document.droppedConflicts ||
		!document.records.length
	)
		throw new Error("Recovery journal is absent, mismatched, empty, or has conflicts");
	for (const record of document.records) {
		if (record.payload.origin && record.payload.origin.sessionId !== args.sessionId)
			throw new Error("Recovery receipt belongs to another session");
	}
	const manager = SessionManager.materializeMissingEmptySession({
		cwd: args.cwd,
		agentDir: args.agentDir,
		sessionFile,
		id: args.sessionId,
		timestamp: args.headerTimestamp,
		version: args.headerVersion,
	});
	const usage = sessionSemanticUsageOf(manager);
	const warnings: string[] = [];
	usage.bindDiagnostics((message) => warnings.push(message));
	usage.dispose();
	const ledger = createSessionManagerLedgerPort(manager);
	const committed: string[] = [];
	const unconfirmed: string[] = [];
	for (const record of document.records) {
		try {
			const report = semanticUsageReportOf(record.payload);
			const row = ledger.findCanonical(record.reportId);
			if (
				row &&
				isDeepStrictEqual(normalizedReport(row.data), normalizedReport(report)) &&
				ledger.physicalState(row.entryId, report) === "persisted"
			)
				committed.push(record.reportId);
			else unconfirmed.push(record.reportId);
		} catch (error) {
			unconfirmed.push(record.reportId);
			warnings.push(
				`Physical confirmation failed for ${record.reportId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return {
		committed,
		unconfirmed,
		journalRemaining: existsSync(slot.path),
		residualSidecars: sessionJournalPaths(sessionFile),
		warnings,
	};
}
