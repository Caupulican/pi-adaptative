/** Attributes concurrent in-process writes and carries unknown workspace effects into peer claim review. */
import path from "node:path";
import type { WorkerHostFinding } from "../autonomy/contracts.ts";
import { hostFinding } from "../autonomy/host-findings.ts";
import { findRepositoryGitPaths, realPathIdentity } from "../autonomy/path-scope.ts";
import { boundedText, quotedSpan } from "../util/bounded-line.ts";

const MAX_FINISHED_SPANS = 128;
const MAX_FINDINGS = 12;
/**
 * A claim blocker longer than 1000 characters is dropped whole, so a finding is kept well inside it. A longer path
 * puts its leading directories behind an elision and keeps the trailing components that fit, file name included.
 */
const MAX_PATH_CHARS = 300;

export interface WorkerWriteSpanInput {
	attemptId: string;
	laneId: string;
	agentId: string;
	/** The directory this worker's relative changed files resolve against. */
	cwd: string;
	/** The worker's live changed-file set while it runs (cwd-relative or absolute). */
	changedFiles: () => Iterable<string>;
	/** True once the host has recorded an operation whose workspace effects it cannot confirm. */
	hasUncertainMutation: () => boolean;
}

interface PeerEvidence {
	laneId: string;
	agentId: string;
	checkout: string;
	files: ReadonlySet<string>;
	uncertain: boolean;
}

interface ActiveSpan extends WorkerWriteSpanInput {
	checkout: string;
	/** Only peers that physically ran alongside this span. Snapshots are shared between active peers. */
	finished: PeerEvidence[];
	incompleteHistory: boolean;
}

function snapshot(span: ActiveSpan): PeerEvidence {
	const files = new Set<string>();
	for (const file of span.changedFiles()) files.add(path.resolve(span.cwd, file));
	return {
		laneId: span.laneId,
		agentId: span.agentId,
		checkout: span.checkout,
		files,
		uncertain: span.hasUncertainMutation(),
	};
}

function uncertainPeerFinding(writer: PeerEvidence, peer: PeerEvidence): WorkerHostFinding | undefined {
	if (!peer.uncertain || writer.checkout !== peer.checkout) return undefined;
	for (const file of writer.files) {
		if (peer.files.has(file)) continue; // The exact-path finding already identifies both writers.
		return hostFinding(
			"mutation_uncertain",
			`Worker ${peer.laneId} (agent ${peer.agentId}) ran an operation with unknown file effects in the same checkout as worker ${writer.laneId} (agent ${writer.agentId}). Their runs overlapped. Check ${quotedSpan(boundedText(file, MAX_PATH_CHARS, { path: true }))} and the writer's other tracked changes before accepting them.`,
		);
	}
	return undefined;
}

const MAX_CLAIM_HOST_FINDINGS = 8;

/**
 * The host findings one claim carries: the first {@link MAX_CLAIM_HOST_FINDINGS}, then one bounded line saying how
 * many were left out, so a cut is always visible. A claim holds at most 32 blockers of 1,000 characters.
 */
export function boundHostFindings(findings: readonly WorkerHostFinding[]): WorkerHostFinding[] {
	if (findings.length <= MAX_CLAIM_HOST_FINDINGS) return [...findings];
	const omitted = findings.length - MAX_CLAIM_HOST_FINDINGS;
	return [
		...findings.slice(0, MAX_CLAIM_HOST_FINDINGS),
		hostFinding(
			"omitted",
			`${omitted} further host finding(s) were omitted from this claim to keep it bounded; review the protected paths and the files this worker changed directly.`,
		),
	];
}

export class WorkerWriteOverlapTracker {
	private readonly active = new Map<string, ActiveSpan>();

	begin(span: WorkerWriteSpanInput): void {
		const physicalCwd = realPathIdentity(span.cwd);
		const checkout = findRepositoryGitPaths(physicalCwd)?.root ?? physicalCwd;
		this.active.set(span.attemptId, { ...span, checkout, finished: [], incompleteHistory: false });
	}

	/** The same evidence feeds normal completion, failure and cancellation. */
	findingsFor(attemptId: string): WorkerHostFinding[] {
		const span = this.active.get(attemptId);
		if (!span) return [];
		const mine = snapshot(span);
		if (!mine.files.size && !mine.uncertain) return [];
		const findings: WorkerHostFinding[] = [];
		let omitted = 0;
		const compare = (other: PeerEvidence) => {
			for (const [writer, peer] of [
				[mine, other],
				[other, mine],
			] as const) {
				const finding = uncertainPeerFinding(writer, peer);
				if (!finding) continue;
				if (findings.length < MAX_FINDINGS) findings.push(finding);
				else omitted++;
			}
			for (const file of mine.files) {
				if (!other.files.has(file)) continue;
				if (findings.length >= MAX_FINDINGS) {
					omitted++;
					continue;
				}
				findings.push(
					hostFinding(
						"overlap",
						`${quotedSpan(boundedText(file, MAX_PATH_CHARS, { path: true }))} was changed by both worker ${mine.laneId} (agent ${mine.agentId}) and worker ${other.laneId} (agent ${other.agentId}) while their runs overlapped, with no write reservation between them. Neither was blocked; compare both changes before accepting either.`,
					),
				);
			}
		};
		if (span.incompleteHistory) {
			findings.push(
				hostFinding(
					"omitted",
					"Concurrent worker write history exceeded its limit. Review the final state of this worker's changes and those of its peers.",
				),
			);
		}
		for (const other of this.active.values()) {
			if (other.agentId !== mine.agentId) compare(snapshot(other));
		}
		for (const other of span.finished) compare(other);
		if (omitted > 0)
			findings.push(hostFinding("omitted", `${omitted} further concurrent-write finding(s) not listed.`));
		return findings;
	}

	end(attemptId: string): void {
		const span = this.active.get(attemptId);
		if (!span) return;
		this.active.delete(attemptId);
		const done = snapshot(span);
		if (!done.files.size && !done.uncertain) return;
		for (const peer of this.active.values()) {
			if (peer.agentId === done.agentId || (!done.files.size && peer.checkout !== done.checkout)) continue;
			if (peer.finished.length < MAX_FINISHED_SPANS) peer.finished.push(done);
			else peer.incompleteHistory = true;
		}
	}
}
