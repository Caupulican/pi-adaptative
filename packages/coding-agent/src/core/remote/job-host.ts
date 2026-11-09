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
		}
		if (activeExecutorJobs(this.store) >= Math.min(runner.room, settings.jobRoom)) return { refusal: "no_room" };
		return checkout ? { checkout } : {};
	}

	async offer(peer: LinkPeer, offer: JobOffer, now = Date.now()): Promise<void> {
		const name = executorRecordName(peer.machineId, offer.jobId);
		const digest = digestOffer(offer);
		const existing = this.store.in.read(name);
		if (existing) {
			// A resend after a lost link: answer as before. Another offer under the same id changes nothing.
			if (existing.offerDigest !== digest) return this.refuse(peer, offer.jobId, "duplicate_conflict");
			peer.send({ t: "job.accept", jobId: offer.jobId });
			this.pump(peer);
			return;
		}
		const settings = loadLinkSettings(this.store.agentDir);
		const decision = await this.decide(peer, offer, settings);
		if ("refusal" in decision) return this.refuse(peer, offer.jobId, decision.refusal);
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

	/** The placer stops the job; the runner ends it as cancelled. A job already finished is left as it is. */
	cancel(peer: LinkPeer, jobId: string, reason: JobCancelReason): void {
		let marked = false;
		this.store.updateExecuted(peer.machineId, jobId, (current) => {
			if (current.state === "terminal" || current.cancel) return undefined;
			marked = true;
			return { ...current, cancel: reason };
		});
		if (marked)
			journalJob(this.store.agentDir, {
				side: "executor",
				jobId,
				peer: peer.machineId,
				event: "cancel",
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
		if (!this.store.in.read(executorRecordName(peer.machineId, entry.jobId))) {
			peer.send({ t: "job.refuse", jobId: entry.jobId, reason: "bad_offer" });
			return;
		}
		if (entry.lastAckedSeq > 0) this.ack(peer, entry.jobId, entry.lastAckedSeq);
		this.pump(peer);
	}

	/** Writes every outbox frame of `peer`'s jobs not yet written on this connection. */
	pump(peer: LinkPeer): void {
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
