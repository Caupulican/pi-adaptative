/**
 * The real external-acquisition execution boundary.
 *
 * A command that fetches, installs, or executes external code is screened by the
 * ExternalCapabilityAcquisitionGate before it runs, not after. Ordinary work — building, testing,
 * reading, git status — is not acquisition and is never screened here.
 * Conforms to GOVERNANCE_LIVE_PATHS.md and RCG-045.
 */

import type { ExternalCapabilityAcquisitionGate } from "./external-capability-acquisition-gate.ts";
import { isPackageInstall } from "./external-capability-acquisition-gate.ts";
import type { AcquisitionDecision } from "./types.ts";

/** Tools whose arguments can start an external acquisition. */
const ACQUISITION_CAPABLE_TOOLS: readonly string[] = ["bash", "run_process", "python", "powershell"];

/**
 * A download of code or an installable artifact: a URL naming a script, an archive or a package file.
 * Calling an API or sending data with curl is not an acquisition (it acquires no code); a send is an
 * outward operation, judged by System One's operation gate instead.
 */
const NETWORK_FETCH_PATTERN =
	/https?:\/\/[^\s'"|;]+\.(?:sh|ps1|py|tar\.gz|tgz|zip|exe|bin|deb|rpm|pkg|msi|dmg|appimage|whl|jar)\b/i;
const FETCH_TO_SHELL_PATTERN = /(?:curl|wget|iwr|irm)[^|\n]*\|\s*(?:bash|sh|zsh|pwsh|powershell|iex)/i;

/** The command text a tool call is asking to execute, if any. */
export function commandFromToolArgs(args: unknown): string | undefined {
	const record = args as Record<string, unknown> | undefined;
	for (const key of ["command", "cmd", "script", "code"]) {
		const value = record?.[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

export interface AcquisitionClassification {
	readonly isAcquisition: boolean;
	readonly command: string;
	/** What makes it an acquisition, for the record and the operator. */
	readonly reasons: readonly string[];
}

/**
 * Classifies a tool call as an external acquisition. Deterministic and conservative in the direction
 * that matters: a command that only builds or tests is not an acquisition, so ordinary work is never
 * routed through the gate.
 */
export function classifyAcquisition(toolName: string, args: unknown): AcquisitionClassification | undefined {
	if (!ACQUISITION_CAPABLE_TOOLS.includes(toolName)) return undefined;
	const command = commandFromToolArgs(args);
	if (!command) return undefined;

	const reasons: string[] = [];
	if (FETCH_TO_SHELL_PATTERN.test(command)) reasons.push("fetch_to_shell");
	if (NETWORK_FETCH_PATTERN.test(command)) reasons.push("network_fetch");
	if (isPackageInstall({ objectiveId: "", source: command, command })) reasons.push("package_install");
	if (reasons.length === 0) return undefined;
	return { isAcquisition: true, command, reasons };
}

export interface AcquisitionBoundaryDeps {
	getGate(): ExternalCapabilityAcquisitionGate | undefined;
	getObjectiveId(): string;
	/** The owner's request this turn serves. */
	getRequest(): string;
	/** Bounded operator-visible notice for a blocked or hardened acquisition. */
	onDecision?(decision: AcquisitionDecision, classification: AcquisitionClassification): void;
}

export interface AcquisitionBlock {
	readonly block: true;
	readonly reason: string;
}

/**
 * Screens one tool call. Returns a block when the acquisition is denied or must be replaced by a
 * safer route; the block text carries the resolved route so the model can actually act on it.
 */
export async function screenAcquisition(
	deps: AcquisitionBoundaryDeps,
	toolName: string,
	args: unknown,
	signal?: AbortSignal,
): Promise<AcquisitionBlock | undefined> {
	const classification = classifyAcquisition(toolName, args);
	if (!classification) return undefined;
	const gate = deps.getGate();
	if (!gate) return undefined;

	const decision = await gate.evaluateAcquisition({
		objectiveId: deps.getObjectiveId(),
		request: deps.getRequest(),
		source: classification.command,
		command: classification.command,
		signal,
	});
	deps.onDecision?.(decision, classification);

	if (decision.allowed) return undefined;

	if (decision.denied) {
		return {
			block: true,
			reason: `External acquisition blocked: ${decision.summaryEvent ?? "not authorized"}. Acquisition record ${decision.record.record_id}.`,
		};
	}

	const resolved = decision.resolvedRoute;
	const replacement = resolved?.command
		? ` Run this instead: ${resolved.command}`
		: resolved
			? ` ${resolved.rationale}`
			: "";
	return {
		block: true,
		reason: `External acquisition replaced by a safer route (${decision.chosenRoute ?? "unresolved"}).${replacement} Acquisition record ${decision.record.record_id}.`,
	};
}
