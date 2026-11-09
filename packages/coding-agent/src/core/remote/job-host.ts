/**
 * The executor's side of the job link: what this machine does with a job a peer places here. An offer is admitted at
 * most once (`JobStore.admit`, keyed by the placer's install id and the job id, bound to the offer's digest) after a
 * fixed order of code checks; an admitted job is run by the session holding the runner lock (`job-runner.ts`), never
 * here. Progress and the outcome leave from the record's outbox until the placer acknowledges them, so a lost link
 * loses nothing: the next connection resends what was not acknowledged.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import { type OfferedCheckout, offeredCheckouts } from "./capabilities.ts";
import {
	digestOffer,
	type JobCancelReason,
	type JobOffer,
	type JobRefusal,
	type JobResumeEntry,
	type LinkPeer,
	MAX_JOB_HOPS,
	MAX_RESUME_ENTRIES,
} from "./job-protocol.ts";
import { activeExecutorJobs, executorRecordName, type JobStore, journalJob, readRunner } from "./job-store.ts";
import { type LinkSettings, loadLinkSettings } from "./registry.ts";

/** Whether this machine runs jobs `peer` places: the owner's choice, else yes from the hub it joined and no otherwise. */
export function acceptsJobsFrom(peer: Pick<LinkPeer, "machineId" | "role">, settings: LinkSettings): boolean {
	return settings.peers[peer.machineId]?.acceptsJobs ?? peer.role === "hub";
}

export class JobHost {
	private readonly store: JobStore;
	private readonly selfId: string;
	/** Per connection: the highest outbox number already written to it, by record name. */
	private readonly sent = new Map<string, number>();
	/**
	 * Stops a record could not take (a failed write), by peer and job: a placer marks its stop sent once it is written, so nothing else
	 * resends it on the connection. They are applied again at the next flush of their peer.
	 */
	private readonly heldStops = new Map<
		string,
		{ readonly peer: string; readonly jobId: string; readonly reason: JobCancelReason }
	>();

	constructor(store: JobStore, selfId: string) {
		this.store = store;
		this.selfId = selfId;
	}

	/** A new connection starts with nothing sent on it. */
	reset(peerId: string): void {
		for (const name of [...this.sent.keys()]) if (name.startsWith(`${peerId}.`)) this.sent.delete(name);
	}

	/** Why the offer is refused, in a fixed order of code facts; undefined admits it (with the checkout it reads). */
	private async decide(
		peer: LinkPeer,
		offer: JobOffer,
		settings: LinkSettings,
	): Promise<{ refusal: JobRefusal } | { checkout?: OfferedCheckout }> {
		if (offer.kind === "leader") return { refusal: "leader_unsupported" };
		// A conversation turn travels as a chat message; an offer of this kind is not one a placer sends.
		if (offer.kind === "ask") return { refusal: "bad_offer" };
		if (offer.hops.length > MAX_JOB_HOPS) return { refusal: "too_deep" };
		if (offer.hops.includes(this.selfId)) return { refusal: "would_loop" };
		if (offer.hops.at(-1) !== peer.machineId) return { refusal: "bad_offer" };
		if (!acceptsJobsFrom(peer, settings)) return { refusal: "jobs_disabled" };
		if (offer.envelope.writes) return { refusal: "writes_disabled" };
		const trust = settings.peers[peer.machineId]?.trust ?? "changes";
		if (offer.repo && trust === "answers") return { refusal: "envelope_exceeds_ceiling" };
		const runner = readRunner(this.store.agentDir);
		if (!runner) return { refusal: "no_room" };
		if (runner.models.length === 0) return { refusal: "no_model" };
		let checkout: OfferedCheckout | undefined;
		if (offer.repo) {
			const repoKey = offer.repo.repoKey;
			checkout = (await offeredCheckouts(settings)).find((entry) => entry.fact.repoKey === repoKey);
			if (!checkout) return { refusal: "unknown_repo" };
			// A checkout the owner has not readied (its dependencies are not installed) is not a place to run a job.
			if (!checkout.fact.ready) return { refusal: "needs_setup" };
		}
		return checkout ? { checkout } : {};
	}

	async offer(peer: LinkPeer, offer: JobOffer, now = Date.now()): Promise<void> {
		const name = executorRecordName(peer.machineId, offer.jobId);
		const digest = digestOffer(offer);
		const existing = this.store.in.inspect(name);
		// A record this build cannot read is neither absent nor a conflict it can judge: nothing is answered and nothing is written over it.
		if (existing.kind === "unreadable") return;
		if (existing.kind === "valid") {
			// A resend after a lost link: answer as before. Another offer under the same id changes nothing.
			if (existing.record.offerDigest !== digest) return this.refuse(peer, offer.jobId, "duplicate_conflict");
			// A finished job whose outcome the placer acknowledged holds nothing to send: an accept would leave the placer waiting for an
			// outcome that will never come, so the offer is refused. A job still holding its outcome answers accept and resends it.
			if (existing.record.state === "terminal" && existing.record.outbox.length === 0)
				return this.refuse(peer, offer.jobId, "duplicate_conflict");
			peer.send({ t: "job.accept", jobId: offer.jobId });
			this.pump(peer);
			return;
		}
		const settings = loadLinkSettings(this.store.agentDir);
		const decision = await this.decide(peer, offer, settings);
		if ("refusal" in decision) return this.refuse(peer, offer.jobId, decision.refusal);
		// The room is read and the job admitted in one synchronous step: no offer from any peer is admitted between the two.
		const runner = readRunner(this.store.agentDir);
		if (
			!runner ||
			activeExecutorJobs(this.store, now, settings.offlineHoldMs) >= Math.min(runner.room, settings.jobRoom)
		)
			return this.refuse(peer, offer.jobId, "no_room");
		const admitted = this.store.admit({
			v: 1,
			placerId: peer.machineId,
			placerName: peer.name,
			jobId: offer.jobId,
			offer,
			offerDigest: digest,
			state: "admitted",
			admittedAt: now,
			deadlineAt: now + offer.deadlineMs,
			...(decision.checkout ? { checkout: decision.checkout.path } : {}),
			seq: 0,
			outbox: [],
			ackedSeq: 0,
		});
		// Written by another build meanwhile: nothing is answered for it, as above.
		if (admitted.kind === "unreadable") return;
		if (admitted.kind === "conflict") return this.refuse(peer, offer.jobId, "duplicate_conflict");
		if (admitted.kind === "admitted")
			journalJob(this.store.agentDir, {
				side: "executor",
				jobId: offer.jobId,
				peer: peer.machineId,
				event: "admitted",
			});
		peer.send({ t: "job.accept", jobId: offer.jobId });
		this.pump(peer);
	}

	/**
	 * An offer whose handling threw (`JobTransport` catches it). The placer is answered at once, not at its deadline: an offer whose job has
	 * a record is answered as a resend would be (the record holds what was admitted), and an offer that admitted nothing is refused as
	 * `offer_failed`. A record this build cannot read takes no answer, as in `offer`.
	 */
	async offerFailed(peer: LinkPeer, offer: JobOffer): Promise<void> {
		if (this.store.in.inspect(executorRecordName(peer.machineId, offer.jobId)).kind !== "absent")
			return this.offer(peer, offer);
		this.refuse(peer, offer.jobId, "offer_failed");
	}

	private refuse(peer: LinkPeer, jobId: string, reason: JobRefusal): void {
		harnessLog.info("link", "a placed job was refused", { peer: peer.machineId, jobId, reason });
		journalJob(this.store.agentDir, {
			side: "executor",
			jobId,
			peer: peer.machineId,
			event: "refused",
			code: reason,
		});
		peer.send({ t: "job.refuse", jobId, reason });
	}

	/** The placer holds every frame up to `seq`: they leave the outbox. */
	ack(peer: LinkPeer, jobId: string, seq: number): void {
		let trimmed = false;
		const record = this.store.updateExecuted(peer.machineId, jobId, (current) => {
			if (seq <= current.ackedSeq) return undefined;
			trimmed = true;
			return {
				...current,
				ackedSeq: Math.min(seq, current.seq),
				outbox: current.outbox.filter((entry) => entry.seq > seq),
			};
		});
		if (trimmed && record?.state === "terminal" && record.outbox.length === 0)
			journalJob(this.store.agentDir, { side: "executor", jobId, peer: peer.machineId, event: "delivered" });
	}

	/**
	 * The placer stops the job; the runner ends it as cancelled. A job already finished is left as it is. A record this build cannot
	 * read takes a cancel marker beside it (the runner honors it), never a write.
	 */
	cancel(peer: LinkPeer, jobId: string, reason: JobCancelReason): void {
		const key = `${peer.machineId}:${jobId}`;
		let outcome: ReturnType<JobStore["cancelExecuted"]>;
		try {
			outcome = this.store.cancelExecuted(peer.machineId, jobId, reason);
		} catch (error) {
			this.heldStops.set(key, { peer: peer.machineId, jobId, reason });
			harnessLog.warn(
				"link",
				"a placed job's stop could not be recorded; it is held and applied again at the next flush",
				{
					peer: peer.machineId,
					jobId,
					reason: error instanceof Error ? error.name : "unknown",
				},
			);
			return;
		}
		this.heldStops.delete(key);
		if (outcome === "unchanged") return;
		journalJob(this.store.agentDir, {
			side: "executor",
			jobId,
			peer: peer.machineId,
			event: outcome === "marked" ? "cancel_marked" : "cancel",
			code: reason,
		});
	}

	/** Every job from `peer` whose frames are not all acknowledged, for this side's resume. */
	resumeEntries(peer: LinkPeer): JobResumeEntry[] {
		return this.store.in
			.list()
			.filter(
				(record) => record.placerId === peer.machineId && (record.state !== "terminal" || record.outbox.length > 0),
			)
			.slice(0, MAX_RESUME_ENTRIES)
			.map((record) => ({ jobId: record.jobId, role: "executor", lastAckedSeq: record.ackedSeq }));
	}

	/** The placer's resume names a job it placed here: unknown is refused (it ends as lost there), known is resent. */
	resume(peer: LinkPeer, entry: JobResumeEntry): void {
		const state = this.store.in.inspect(executorRecordName(peer.machineId, entry.jobId));
		// An unreadable record is not an absent one: nothing is refused for it, so the placer keeps its job until the record reads again.
		if (state.kind === "unreadable") return;
		if (state.kind === "absent") {
			peer.send({ t: "job.refuse", jobId: entry.jobId, reason: "bad_offer" });
			return;
		}
		if (entry.lastAckedSeq > 0) this.ack(peer, entry.jobId, entry.lastAckedSeq);
		this.pump(peer);
	}

	/** Writes every outbox frame of `peer`'s jobs not yet written on this connection, after the stops held for it are applied again. */
	pump(peer: LinkPeer): void {
		for (const held of [...this.heldStops.values()])
			if (held.peer === peer.machineId) this.cancel(peer, held.jobId, held.reason);
		for (const record of this.store.in.list()) {
			if (record.placerId !== peer.machineId) continue;
			const name = executorRecordName(record.placerId, record.jobId);
			let sent = Math.max(this.sent.get(name) ?? 0, record.ackedSeq);
			for (const entry of record.outbox) {
				if (entry.seq <= sent) continue;
				if (!peer.send(entry.frame)) break;
				sent = entry.seq;
			}
			this.sent.set(name, sent);
		}
	}
}
