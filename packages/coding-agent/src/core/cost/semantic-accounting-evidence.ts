import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getModel } from "@caupulican/pi-ai/models";
import { indexSessionLifecycle } from "../../kernel/session/lifecycle-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { createEmptyUsage, getSessionEntryUsage } from "../../kernel/usage.ts";
import { typeSafeEvidenceDir } from "../agent-paths.ts";
import { getEvaluationUsage } from "../review/typesafe-contract.ts";
import { parseTypeSafeUsageReceipt } from "../review/typesafe-usage-receipt-codec.ts";
import { SYSTEM_ONE_TOOL_NAME } from "../system-one/tool-names.ts";
import { isMissingFileError } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { AccountingEvidenceGroup, AccountingOrigin, AccountingSourceRevision } from "./accounting-evidence.ts";
import { type SemanticUsageReport, semanticUsageReportOf } from "./usage-records.ts";

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 25_000;
// v1 evidence used the original tool name before its model-facing rename. This applies only to archived artifacts.
const ARCHIVED_REVIEW_TOOL_NAMES = new Set<string>([SYSTEM_ONE_TOOL_NAME, "typesafe_review"]);

/** The peer owner admits only the exact requested ref and passes that model through isolated completion. */
function requestedPeerForResult(entries: readonly SessionEntry[], result: SessionEntry): string | undefined {
	if (result.type !== "message" || result.message.role !== "toolResult") return undefined;
	const toolCallId = result.message.toolCallId;
	const index = indexSessionLifecycle(entries, result.id);
	if (index.ambiguousResultEntryIds.includes(result.id)) return undefined;
	const matches = index.toolResults.filter((item) => item.resultMessageEntryId === result.id);
	if (matches.length !== 1) return undefined;
	const assistantId = matches[0]!.assistantMessageEntryId;
	const assistant = assistantId ? index.entriesById.get(assistantId) : undefined;
	if (assistant?.type !== "message" || assistant.message.role !== "assistant") return undefined;
	const calls = assistant.message.content.filter(
		(block) => block.type === "toolCall" && block.id === toolCallId && block.name === "peer",
	);
	if (calls.length !== 1 || calls[0]?.type !== "toolCall") return undefined;
	const args = calls[0].arguments;
	return isPlainRecord(args) &&
		args.action === "review" &&
		isPlainRecord(args.review) &&
		typeof args.review.peer === "string"
		? args.review.peer
		: undefined;
}

function recordedDirectToolEvidence(entries: readonly SessionEntry[], sessionId: string): AccountingEvidenceGroup[] {
	const groups: AccountingEvidenceGroup[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message;
		const usage = getSessionEntryUsage(entry);
		if (!usage || !isPlainRecord(message.details)) continue;
		const details = message.details;
		let provider: string | undefined;
		let model: string | undefined;
		let requestBound = false;
		if (ARCHIVED_REVIEW_TOOL_NAMES.has(message.toolName) && isPlainRecord(details.costProvenance)) {
			if (typeof details.costProvenance.provider === "string" && typeof details.costProvenance.model === "string") {
				provider = details.costProvenance.provider;
				model = details.costProvenance.model;
			}
		} else if (message.toolName === "peer" && isPlainRecord(details.peer) && typeof details.peer.ref === "string") {
			const separator = details.peer.ref.indexOf("/");
			if (separator > 0 && separator < details.peer.ref.length - 1) {
				provider = details.peer.ref.slice(0, separator);
				model = details.peer.ref.slice(separator + 1);
			}
		}
		if (
			!model &&
			message.toolName === "peer" &&
			message.isError &&
			isPlainRecord(details.piToolFailureMemory) &&
			details.piToolFailureMemory.tool === "peer"
		) {
			const reference = requestedPeerForResult(entries, entry);
			const separator = reference?.indexOf("/") ?? -1;
			if (reference && separator > 0 && separator < reference.length - 1) {
				provider = reference.slice(0, separator);
				model = reference.slice(separator + 1);
				requestBound = true;
			}
		}
		if (!provider || !model) continue;
		const costStatus =
			details.costStatus === "unpriced" || details.costStatus === "catalog_priced" ? details.costStatus : undefined;
		groups.push({
			reportIds: [],
			origin: { sessionId, entryId: entry.id, toolCallId: message.toolCallId },
			directEntries: [
				{
					entryId: entry.id,
					usage,
					provider,
					model,
					...(costStatus ? { costStatus } : {}),
					...(requestBound ? { modelProvenance: "request-bound" as const } : {}),
				},
			],
			...(requestBound
				? {
						diagnostic:
							"Model provenance is request-bound to the exact canonical peer invocation; response model metadata was not retained.",
					}
				: {}),
			evidence: [],
		});
	}
	return groups;
}

function directToolEvidence(
	artifact: { toolCallId: string; record: Record<string, unknown> },
	metadata: Record<string, unknown>,
	entries: readonly SessionEntry[],
	sessionId: string,
	evidence: readonly AccountingSourceRevision[],
): AccountingEvidenceGroup | undefined {
	// Before the tool rename, paid usage was on the tool result rather than a semantic receipt.
	if (metadata.toolName !== "typesafe_review" || artifact.record.costStatus !== "unpriced") return undefined;
	const candidates = entries.filter((entry) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
		const message = entry.message;
		if (message.toolCallId !== artifact.toolCallId || message.toolName !== metadata.toolName) return false;
		const details = message.details;
		if (!isPlainRecord(details) || !isPlainRecord(details.evidence)) return false;
		return (
			details.evidence.id === metadata.id &&
			details.evidence.sha256 === metadata.command &&
			details.evidence.bytes === metadata.byteLength
		);
	});
	if (candidates.length > 1) throw new Error("Historical review evidence matches multiple canonical tool results.");
	const entry = candidates[0];
	if (!entry) return undefined;
	const usage = getSessionEntryUsage(entry);
	if (!usage) return undefined;
	const attempts = artifact.record.transportAttempts;
	if (!Array.isArray(attempts)) throw new Error("Historical review usage lacks its transport responses.");
	const tokens = createEmptyUsage();
	let model: string | undefined;
	for (const attempt of attempts) {
		if (!isPlainRecord(attempt)) throw new Error("Historical review transport attempt is malformed.");
		const spent = getEvaluationUsage(attempt.response);
		if (!spent) continue;
		if (!isPlainRecord(attempt.response) || typeof attempt.response.model !== "string" || !attempt.response.model)
			throw new Error("Historical review response lacks model identity.");
		if (model !== undefined && model !== attempt.response.model)
			throw new Error("Historical review responses disagree on model identity.");
		model = attempt.response.model;
		tokens.input += spent.input_tokens;
		tokens.output += spent.output_tokens;
		tokens.totalTokens += spent.input_tokens + spent.output_tokens;
	}
	if (
		!model ||
		tokens.input !== usage.input ||
		tokens.output !== usage.output ||
		tokens.cacheRead !== usage.cacheRead ||
		tokens.cacheWrite !== usage.cacheWrite ||
		tokens.totalTokens !== usage.totalTokens
	)
		throw new Error("Historical review responses do not conserve the recorded tool usage.");
	if (!getModel("typesafe", model)) throw new Error("Historical review model has no exact TypeSafe catalog identity.");
	return {
		reportIds: [],
		origin: { sessionId, entryId: entry.id, toolCallId: artifact.toolCallId },
		directEntries: [{ entryId: entry.id, usage, provider: "typesafe", model, costStatus: "unpriced" }],
		evidence,
	};
}

/** Recover only exact paid-receipt links. Artifact timestamps and evaluation IDs never imply ownership. */
export function readSemanticAccountingEvidence(options: {
	agentDir: string;
	sessionId: string;
	reports: readonly SemanticUsageReport[];
	entries?: readonly SessionEntry[];
}): AccountingEvidenceGroup[] {
	const directGroups = recordedDirectToolEvidence(options.entries ?? [], options.sessionId);
	const directory = typeSafeEvidenceDir(options.agentDir, options.sessionId);
	try {
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Semantic evidence path is not a directory.");
	} catch (error) {
		if (isMissingFileError(error)) return directGroups;
		throw error;
	}
	const reports = new Map(options.reports.map((report) => [report.reportId, report]));
	const groups = new Map(directGroups.map((group) => [`direct:${group.directEntries![0]!.entryId}`, group]));
	let totalBytes = 0;
	for (const name of readBoundedDirectoryNamesSync(
		directory,
		MAX_DIRECTORY_ENTRIES,
		"Semantic evidence directory",
	).sort()) {
		if (!/^[a-f0-9]{24}\.meta\.json$/.test(name)) continue;
		const id = name.slice(0, -".meta.json".length);
		const revisions: AccountingSourceRevision[] = [];
		const read = (path: string): string => {
			const text = readBoundedTextFileSync(path, MAX_ARTIFACT_BYTES, "Semantic evidence artifact");
			const size = Buffer.byteLength(text);
			totalBytes += size;
			if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Semantic evidence exceeds its total byte limit.");
			revisions.push({ path, size, sha256: createHash("sha256").update(text).digest("hex") });
			return text;
		};
		const metadata: unknown = JSON.parse(read(join(directory, name)));
		if (!isPlainRecord(metadata) || !isPlainRecord(metadata.ref) || metadata.ref.id !== id) {
			throw new Error("Semantic evidence metadata has invalid identity.");
		}
		if (typeof metadata.ref.toolName !== "string" || !ARCHIVED_REVIEW_TOOL_NAMES.has(metadata.ref.toolName))
			throw new Error("Semantic evidence belongs to another tool.");
		const payload = read(join(directory, `${id}.payload`));
		if (metadata.ref.command !== revisions[1]!.sha256 || metadata.ref.byteLength !== Buffer.byteLength(payload)) {
			throw new Error("Semantic evidence payload does not match its recorded digest or size.");
		}
		const artifact: unknown = JSON.parse(payload);
		if (!isPlainRecord(artifact) || artifact.version !== 1 || !isPlainRecord(artifact.record)) {
			throw new Error("Semantic evidence payload has invalid structure.");
		}
		if (typeof artifact.toolCallId !== "string" || artifact.toolCallId.length === 0) {
			throw new Error("Semantic evidence lacks its outer tool-call identity.");
		}
		if (!Array.isArray(artifact.record.receipts)) {
			const direct = directToolEvidence(
				{ toolCallId: artifact.toolCallId, record: artifact.record },
				metadata.ref,
				options.entries ?? [],
				options.sessionId,
				revisions,
			);
			if (direct) groups.set(`direct:${direct.directEntries![0]!.entryId}`, direct);
			continue;
		}
		for (const value of artifact.record.receipts) {
			if (!isPlainRecord(value) || typeof value.reportId !== "string" || !reports.has(value.reportId)) continue;
			const receipt = parseTypeSafeUsageReceipt(value.payload);
			if (!receipt || receipt.receiptId !== value.reportId)
				throw new Error("Semantic evidence receipt identity is invalid.");
			const current = reports.get(value.reportId)!;
			// The tool-specific sink stamps this route at admission; the reviewer's retained payload predates that stamp.
			const recovered = semanticUsageReportOf({ ...receipt, route: "system_one_tool" });
			const { origin: _oldOrigin, ...oldUsage } = current;
			const { origin: _newOrigin, ...newUsage } = recovered;
			if (!isDeepStrictEqual(oldUsage, newUsage))
				throw new Error("Semantic evidence conflicts with the recorded usage receipt.");
			const origin: AccountingOrigin = receipt.origin ?? {
				sessionId: options.sessionId,
				toolCallId: artifact.toolCallId,
			};
			if (origin.toolCallId !== undefined && origin.toolCallId !== artifact.toolCallId) {
				throw new Error("Semantic evidence has conflicting tool-call ownership.");
			}
			const group: AccountingEvidenceGroup = {
				reportIds: [value.reportId],
				origin: { ...origin, toolCallId: artifact.toolCallId },
				evidence: revisions,
			};
			const previous = groups.get(value.reportId);
			if (previous && !isDeepStrictEqual(previous.origin, group.origin)) {
				throw new Error("Semantic receipt appears under conflicting retained tool calls.");
			}
			groups.set(value.reportId, previous ? { ...previous, evidence: [...previous.evidence, ...revisions] } : group);
		}
	}
	return [...groups.values()];
}
