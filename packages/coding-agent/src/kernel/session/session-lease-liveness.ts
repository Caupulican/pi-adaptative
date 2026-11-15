/**
 * The liveness proof of a process that holds session lifetime leases in an orchestration home:
 * `<home>/lease-holders/<processInstanceId>.beat`, written when the process takes its first lease there, written again
 * every `LEASE_RENEW_MS` while it holds any, and removed with its last. It names its process as `ownProcessOwner`
 * describes it at each write, so a proof whose process crashed is removed by the next lease a process of a host that
 * proves it dead takes in that home ({@link holdLeaseLiveness}). A lease registry records each holder by the
 * process facts `judgeOwner` reads, which prove a holder dead only on its own host: a holder recorded on another host,
 * or on one this process cannot place, is never proven dead here. Such a holder is judged by its proof instead: it is
 * stale once this process has seen it unchanged for `LEASE_LIVENESS_WINDOW_MS` on its own monotonic clock, so no
 * two hosts' clocks are compared. A proof that is absent (a holder from a build that predates proofs, or one removed
 * with its process's last lease) is judged the same way, as one that never changes.
 *
 * The proof lives beside the registry, never in it: a registry entry with another key count is refused by every build
 * that reads it, so a new key would make an older build refuse every session a newer one holds.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { isProcessOwnerRecord, judgeOwner, ownProcessOwner, type ProcessOwner } from "../reliability/owner-identity.ts";
import { isMissingFileError, writeFileAtomicSync } from "../storage/atomic-file.ts";
import { FileSnapshotChangedError, readOptionalBoundedTextFileSync } from "../storage/bounded-file.ts";
import { type RepeatingAlarm, repeatEvery, SYSTEM_TIMER_PORT } from "../timer-port.ts";
import type { OrchestrationHome } from "./session-bundle-paths.ts";

/** How often a holder writes its proof again. */
export const LEASE_RENEW_MS = 30_000;
/** How long a proof must stay unchanged, as this process sees it, before its holder counts as gone: six renewals. */
export const LEASE_LIVENESS_WINDOW_MS = 6 * LEASE_RENEW_MS;

const MAX_PROOF_BYTES = 2048;
const PROOF_SUFFIX = ".beat";

/** The homes this process holds leases in, with how many it holds in each. */
const held = new Map<string, { readonly home: OrchestrationHome; count: number }>();
let renewal: RepeatingAlarm | undefined;
let renewals = 0;

/** What this process saw of each other holder's proof, and since when (`performance.now()`) it has not changed. */
const seen = new Map<string, { readonly proof: string | undefined; readonly since: number }>();

function proofDir(home: OrchestrationHome): string {
	return join(home.root, "lease-holders");
}

function proofFile(home: OrchestrationHome, processInstanceId: string): string {
	return join(proofDir(home), `${processInstanceId}${PROOF_SUFFIX}`);
}

function writeProof(home: OrchestrationHome, processInstanceId: string): void {
	const proof = { processInstanceId, owner: ownProcessOwner(), beat: ++renewals };
	writeFileAtomicSync(proofFile(home, processInstanceId), `${JSON.stringify(proof)}\n`);
}

/**
 * The process a proof in `home` names, or undefined when it names none this process can judge: a proof that is gone,
 * being replaced, unreadable or not one this build writes proves nothing, and is left to its holder.
 */
function proofOwner(home: OrchestrationHome, processInstanceId: string): ProcessOwner | undefined {
	let text: string | undefined;
	try {
		text = readOptionalBoundedTextFileSync(
			proofFile(home, processInstanceId),
			MAX_PROOF_BYTES,
			"Session lease holder liveness proof",
		);
	} catch {
		return undefined;
	}
	if (text === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { processInstanceId: named, owner } = value as Record<string, unknown>;
	return named === processInstanceId && isProcessOwnerRecord(owner) ? owner : undefined;
}

/**
 * Removes the proofs in `home` whose process this host proves dead (`judgeOwner`): a process that crashed while it
 * held a lease there leaves its proof behind. Only `dead` removes one; a proof of another host's process, or one
 * this process cannot judge, stays until a process of its own host proves it dead.
 */
function sweepDeadProofs(home: OrchestrationHome, processInstanceId: string): void {
	let names: string[];
	try {
		names = readdirSync(proofDir(home));
	} catch (error) {
		if (isMissingFileError(error)) return;
		throw error;
	}
	for (const name of names) {
		if (!name.endsWith(PROOF_SUFFIX)) continue;
		const holder = name.slice(0, -PROOF_SUFFIX.length);
		if (holder === processInstanceId) continue;
		const owner = proofOwner(home, holder);
		if (owner !== undefined && judgeOwner(owner) === "dead") forgetLeaseLiveness(home, holder);
	}
}

/**
 * This process (`processInstanceId`) takes a lease in `home`: its proof there is written now, before the lease is
 * recorded, and renewed while it holds any lease there. A failure to write it is thrown, and nothing is counted. Each
 * lease it takes there first removes the proofs of processes this host proves dead ({@link sweepDeadProofs}).
 */
export function holdLeaseLiveness(home: OrchestrationHome, processInstanceId: string): void {
	sweepDeadProofs(home, processInstanceId);
	const entry = held.get(home.root);
	if (entry) {
		entry.count++;
		return;
	}
	writeProof(home, processInstanceId);
	held.set(home.root, { home, count: 1 });
	// A renewal that fails is written again at the next: the window spans six, so one missed write ages nothing. A home
	// whose proof directory is gone (the home was removed under a lease) is not made again.
	renewal ??= repeatEvery(SYSTEM_TIMER_PORT, LEASE_RENEW_MS, () => {
		for (const { home: renewed } of held.values()) {
			if (!existsSync(dirname(proofFile(renewed, processInstanceId)))) continue;
			try {
				writeProof(renewed, processInstanceId);
			} catch {
				// Written again at the next renewal (see above); the readers' window, not one write, decides.
			}
		}
	});
}

/** This process released a lease in `home`: with its last there, its proof there is removed. */
export function releaseLeaseLiveness(home: OrchestrationHome, processInstanceId: string): void {
	const entry = held.get(home.root);
	if (!entry || --entry.count > 0) return;
	held.delete(home.root);
	if (held.size === 0) {
		renewal?.stop();
		renewal = undefined;
	}
	rmSync(proofFile(home, processInstanceId), { force: true });
}

/** A holder proven dead was pruned from a registry of `home`: its proof there goes with it. */
export function forgetLeaseLiveness(home: OrchestrationHome, processInstanceId: string): void {
	seen.delete(proofFile(home, processInstanceId));
	rmSync(proofFile(home, processInstanceId), { force: true });
}

/**
 * Whether holder `processInstanceId`'s proof in `home` is stale: this process has seen it unchanged (or absent) for
 * `LEASE_LIVENESS_WINDOW_MS`. The first sight of a proof, and every change of it, starts the window again. A proof that
 * cannot be read is thrown.
 */
export function leaseLivenessExpired(home: OrchestrationHome, processInstanceId: string): boolean {
	const file = proofFile(home, processInstanceId);
	let proof: string | undefined;
	try {
		proof = readOptionalBoundedTextFileSync(file, MAX_PROOF_BYTES, "Session lease holder liveness proof");
	} catch (error) {
		// Replaced while it was read: its holder renewed it just now.
		if (!(error instanceof FileSnapshotChangedError)) throw error;
		seen.set(file, { proof: undefined, since: performance.now() });
		return false;
	}
	const now = performance.now();
	const last = seen.get(file);
	if (!last || last.proof !== proof) {
		seen.set(file, { proof, since: now });
		return false;
	}
	return now - last.since >= LEASE_LIVENESS_WINDOW_MS;
}
