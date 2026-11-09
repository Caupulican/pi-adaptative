/**
 * The one router of capability and job frames, attached to whichever link end this process holds: the hub (its joined
 * machines) or a join (the hub). Both ends speak the same frames; which side of a job this machine is follows from
 * the job's stores, never from the link role. On every proven connection it sends this machine's advert (`cap/1`) and
 * a resume of the jobs in flight with that peer (`jobs/1`), then whatever is waiting: offers the owning session queued
 * (the non-host queue: any session writes a pending record, the process holding the link sends it), outbox frames the
 * runner appended, cancels. Waiting work is found by watching the store directories, never by polling.
 *
 * The placer's side is here: a frame from the executor is persisted before it is acknowledged, or acknowledged without being kept
 * when the placer holds no record of its job (nothing can use it, and the executor's outbox must drain); a second outcome with
 * another digest is kept out as a conflict, and only the executor a job was placed on can speak for it.
 */

import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { type CapabilityFacts, localFacts, offeredCheckouts } from "./capabilities.ts";
import { recordPeerDown, recordPeerFacts, recordPeerUp } from "./fleet-machines.ts";
import { acceptsJobsFrom, JobHost } from "./job-host.ts";
import {
	CAP_FEATURE,
	digestOutcome,
	JOBS_FEATURE,
	type JobFrame,
	type JobResumeEntry,
	type LinkPeer,
	type LinkPeerListener,
	MAX_RESUME_ENTRIES,
} from "./job-protocol.ts";
import {
	activeExecutorJobs,
	inDir,
	JobStore,
	jobsDir,
	journalJob,
	outDir,
	type PlacerJobRecord,
	type RecordRead,
	readRunner,
} from "./job-store.ts";
import { loadLinkSettings } from "./registry.ts";
import { DirectoryWatch } from "./store-watch.ts";

/** What a frame about a placed job found: the record applied to, no record of this peer's, or a record this build cannot use. */
type PlacedFrame = "applied" | "absent" | "unreadable";

export class JobTransport implements LinkPeerListener {
	private readonly agentDir: string;
	private readonly store: JobStore;
	private readonly host: JobHost;
	private readonly peers = new Map<string, LinkPeer>();
	/** Per connection: the pending offers already written to it. */
	private readonly offered = new Set<string>();
	/** Per connection: the cancels sent from a cancel marker (an unreadable record takes no `cancelSent` of its own). */
	private readonly markSent = new Set<string>();
	private readonly lastAdvert = new Map<string, string>();
	private capRev = Date.now();
	private readonly watch: DirectoryWatch;
	/** Offers are decided one at a time per peer, in arrival order. */
	private readonly offerChains = new Map<string, Promise<void>>();
	private readonly onFleetChange: () => void;

	constructor(options: { agentDir: string; selfId: string; onFleetChange?: () => void }) {
		this.agentDir = options.agentDir;
		this.store = new JobStore(options.agentDir);
		this.host = new JobHost(this.store, options.selfId);
		// The job stores, the runner record and the link settings, watched while a job-capable peer is connected.
		this.watch = new DirectoryWatch(
			[
				outDir(options.agentDir),
				inDir(options.agentDir),
				jobsDir(options.agentDir),
				join(options.agentDir, "remote"),
			],
			() => this.flushAll(),
		);
		this.onFleetChange = options.onFleetChange ?? (() => {});
	}

	up(peer: LinkPeer): void {
		this.peers.set(peer.machineId, peer);
		this.host.reset(peer.machineId);
		for (const key of [...this.offered]) if (key.startsWith(`${peer.machineId}:`)) this.offered.delete(key);
		for (const key of [...this.markSent]) if (key.startsWith(`${peer.machineId}:`)) this.markSent.delete(key);
		this.lastAdvert.delete(peer.machineId);
		recordPeerUp(this.agentDir, peer);
		this.onFleetChange();
		harnessLog.info("link", "a peer's job link is up", {
			peer: peer.machineId,
			cap: peer.features.includes(CAP_FEATURE),
			jobs: peer.features.includes(JOBS_FEATURE),
		});
		if (peer.features.includes(CAP_FEATURE)) void this.advertise(peer);
		if (!peer.features.includes(JOBS_FEATURE)) return;
		const active: JobResumeEntry[] = [
			...this.host.resumeEntries(peer),
			...this.placedWith(peer)
				// A conversation turn is a chat message, not a job the executor holds: it has nothing to resume.
				.filter((record) => record.state === "accepted" && record.offer.kind !== "ask")
				.map((record) => ({ jobId: record.jobId, role: "placer" as const, lastAckedSeq: record.lastSeq })),
		].slice(0, MAX_RESUME_ENTRIES);
		peer.send({ t: "job.resume", active });
		this.flush(peer);
		this.watch.start();
	}

	down(machineId: string): void {
		if (!this.peers.delete(machineId)) return;
		recordPeerDown(this.agentDir, machineId);
		this.onFleetChange();
		if (this.peers.size === 0) this.watch.stop();
	}

	receive(machineId: string, frame: JobFrame): void {
		const peer = this.peers.get(machineId);
		if (!peer) return;
		switch (frame.t) {
			case "cap":
				recordPeerFacts(this.agentDir, machineId, frame.facts);
				this.onFleetChange();
				return;
			case "job.offer": {
				const previous = this.offerChains.get(machineId) ?? Promise.resolve();
				const next = previous
					.then(() => this.host.offer(peer, frame.offer))
					.catch((error: unknown) => {
						harnessLog.warn("link", "a placed job could not be admitted", {
							peer: machineId,
							jobId: frame.offer.jobId,
							reason: error instanceof Error ? error.name : "unknown",
						});
					});
				this.offerChains.set(machineId, next);
				void next.then(() => this.scheduleAdvert());
				return;
			}
			case "job.ack":
				this.host.ack(peer, frame.jobId, frame.seq);
				return;
			case "job.cancel":
				this.host.cancel(peer, frame.jobId, frame.reason);
				return;
			case "job.resume":
				for (const entry of frame.active) {
					// The sender's role: a placer's entry names a job running here, an executor's one placed from here.
					if (entry.role === "placer") this.host.resume(peer, entry);
					else this.resumePlaced(peer, entry);
				}
				return;
			case "job.refuse":
				// Either side may refuse: an executor refuses an offer, a placer a job it no longer knows. A record this build
				// cannot read is neither, so nothing is cancelled for it. The stop a placer names with its refusal is the one the
				// executor records; a refusal that names none is the owner's.
				if (this.placerFrame(peer, frame.jobId, (record) => this.refused(record, frame.reason)) === "absent")
					this.host.cancel(peer, frame.jobId, frame.cancel ?? "owner");
				return;
			case "job.accept":
				this.placerFrame(peer, frame.jobId, (record) =>
					record.state === "pending" ? { ...record, state: "accepted" } : undefined,
				);
				return;
			case "job.progress": {
				const placed = this.placerFrame(peer, frame.jobId, (record) =>
					frame.seq <= record.lastSeq || record.state === "terminal" || record.state === "ended"
						? undefined
						: {
								...record,
								state: record.state === "pending" ? "accepted" : record.state,
								lastSeq: frame.seq,
								progress: { seq: frame.seq, phase: frame.phase, ...(frame.line ? { line: frame.line } : {}) },
							},
				);
				// An unreadable record is not an absent one: its frame is neither applied nor acknowledged, so the executor keeps it.
				if (placed !== "unreadable") peer.send({ t: "job.ack", jobId: frame.jobId, seq: frame.seq });
				return;
			}
			case "job.outcome": {
				const digest = digestOutcome(frame.outcome);
				const placed = this.placerFrame(peer, frame.jobId, (record) => {
					if (!record.outcome)
						return {
							...record,
							state: record.state === "ended" ? record.state : "terminal",
							outcome: frame.outcome,
							outcomeDigest: digest,
							lastSeq: Math.max(record.lastSeq, frame.seq),
						};
					if (record.outcomeDigest === digest || record.conflict) return undefined;
					harnessLog.warn("link", "a second, different outcome for a placed job was kept out", {
						peer: machineId,
						jobId: frame.jobId,
					});
					journalJob(this.agentDir, { side: "placer", jobId: frame.jobId, peer: machineId, event: "conflict" });
					return { ...record, conflict: true };
				});
				// Persisted first, acknowledged after: an outcome the placer did not keep is resent. An outcome for a job this placer holds
				// no record of is acknowledged without being kept, since nothing here can use it (the executor's outbox would otherwise
				// never drain). An unreadable record is neither kept nor acknowledged: the executor keeps the outcome and resends it.
				if (placed === "unreadable") return;
				if (placed === "absent")
					harnessLog.info("link", "an outcome for a job with no placed record was acknowledged, not kept", {
						peer: machineId,
						jobId: frame.jobId,
					});
				peer.send({ t: "job.ack", jobId: frame.jobId, seq: frame.seq });
				return;
			}
		}
	}

	dispose(): void {
		for (const machineId of [...this.peers.keys()]) this.down(machineId);
		this.watch.stop();
	}

	private placedWith(peer: LinkPeer): PlacerJobRecord[] {
		return this.store.out.list().filter((record) => record.executorId === peer.machineId);
	}

	/**
	 * The placer's record of `jobId` as a job placed on `peer`. A record that names another machine is not trusted, so it reads as
	 * unreadable (and is warned about), the same as a file this build cannot parse.
	 */
	private placedOn(peer: LinkPeer, jobId: string): RecordRead<PlacerJobRecord> {
		const state = this.store.placedState(peer.machineId, jobId);
		if (state.kind !== "valid" || state.record.executorId === peer.machineId) return state;
		harnessLog.warn("link", "a placed job's record names another machine; it was not used", {
			peer: peer.machineId,
			jobId,
		});
		return { kind: "unreadable" };
	}

	/**
	 * Applies a frame about a job this machine placed on `peer`. `absent`: no record names the job on this peer (a peer can speak
	 * only for jobs placed on it). `unreadable`: the record is there but this build cannot use it; nothing is applied, and the caller
	 * neither refuses, cancels nor acknowledges for it.
	 */
	private placerFrame(
		peer: LinkPeer,
		jobId: string,
		change: (record: PlacerJobRecord) => PlacerJobRecord | undefined,
	): PlacedFrame {
		const state = this.placedOn(peer, jobId);
		if (state.kind === "absent") return "absent";
		if (state.kind === "unreadable") return "unreadable";
		const before = state.record.state;
		const next = this.store.updatePlaced(peer.machineId, jobId, change);
		if (next && next.state !== before)
			journalJob(this.agentDir, {
				side: "placer",
				jobId,
				peer: peer.machineId,
				event: next.state,
				code: next.refusal,
			});
		return "applied";
	}

	private refused(record: PlacerJobRecord, reason: PlacerJobRecord["refusal"]): PlacerJobRecord | undefined {
		if (record.state === "pending") return { ...record, state: "refused", ...(reason ? { refusal: reason } : {}) };
		// An executor that admitted the job and no longer knows it lost it.
		if (record.state === "accepted" && reason === "bad_offer")
			return { ...record, state: "ended", ending: "remote_lost" };
		return undefined;
	}

	/**
	 * The executor's resume names a job placed from here: one this machine no longer runs is refused, so it stops there. An unreadable
	 * record is not an absent one: nothing is refused or acknowledged for it.
	 */
	private resumePlaced(peer: LinkPeer, entry: JobResumeEntry): void {
		const state = this.placedOn(peer, entry.jobId);
		if (state.kind === "unreadable") return;
		const record = state.kind === "valid" ? state.record : undefined;
		if (!record || record.appliedAt !== undefined || record.state === "ended") {
			if (record?.outcome)
				peer.send({ t: "job.ack", jobId: entry.jobId, seq: Math.max(record.lastSeq, entry.lastAckedSeq, 1) });
			// The refusal carries the stop this record holds, so the executor records that reason rather than the owner's.
			else
				peer.send({
					t: "job.refuse",
					jobId: entry.jobId,
					reason: "bad_offer",
					...(record?.cancel ? { cancel: record.cancel } : {}),
				});
		}
	}

	/** Sends everything waiting for `peer`: offers queued by any session, cancels, and the outbox of jobs it placed here. */
	private flush(peer: LinkPeer): void {
		for (const record of this.placedWith(peer)) {
			const key = `${peer.machineId}:${record.jobId}`;
			if (record.state === "pending" && !record.cancel && !this.offered.has(key)) {
				if (peer.send({ t: "job.offer", offer: record.offer })) {
					this.offered.add(key);
					journalJob(this.agentDir, {
						side: "placer",
						jobId: record.jobId,
						peer: peer.machineId,
						event: "offered",
					});
				}
			}
			// A conversation turn is no job on the executor: there is nothing there to stop.
			if (record.cancel && !record.cancelSent && record.state !== "refused" && record.offer.kind !== "ask") {
				if (peer.send({ t: "job.cancel", jobId: record.jobId, reason: record.cancel }))
					this.store.updatePlaced(record.executorId, record.jobId, (current) => ({
						...current,
						cancelSent: true,
					}));
			}
		}
		// A stop kept beside a record this build cannot read is sent from its marker, once per connection: that record cannot take `cancelSent`.
		for (const mark of this.store.placedCancelMarks()) {
			const key = `${mark.machineId}:${mark.jobId}`;
			if (mark.machineId !== peer.machineId || this.markSent.has(key)) continue;
			if (this.store.placedState(mark.machineId, mark.jobId).kind !== "unreadable") continue;
			if (peer.send({ t: "job.cancel", jobId: mark.jobId, reason: mark.reason })) this.markSent.add(key);
		}
		this.host.pump(peer);
	}

	private flushAll(): void {
		for (const peer of this.peers.values()) if (peer.features.includes(JOBS_FEATURE)) this.flush(peer);
		this.scheduleAdvert();
	}

	private scheduleAdvert(): void {
		for (const peer of this.peers.values()) if (peer.features.includes(CAP_FEATURE)) void this.advertise(peer);
	}

	/** Sends this machine's advert to `peer` when it differs from the last one sent on this connection. */
	private async advertise(peer: LinkPeer): Promise<void> {
		try {
			const settings = loadLinkSettings(this.agentDir);
			const checkouts = await offeredCheckouts(settings);
			const facts = localFacts({
				checkouts: checkouts.map((entry) => entry.fact),
				runner: readRunner(this.agentDir),
				activeJobs: activeExecutorJobs(this.store),
				acceptsJobs: acceptsJobsFrom(peer, settings),
			});
			const key = JSON.stringify(facts);
			if (this.lastAdvert.get(peer.machineId) === key || this.peers.get(peer.machineId) !== peer) return;
			this.capRev = Math.max(this.capRev + 1, Date.now());
			const advert: CapabilityFacts = { ...facts, capRev: this.capRev };
			if (peer.send({ t: "cap", facts: advert })) this.lastAdvert.set(peer.machineId, key);
		} catch (error) {
			harnessLog.warn("link", "this machine's capability advert could not be built", {
				peer: peer.machineId,
				reason: error instanceof Error ? error.name : "unknown",
			});
		}
	}
}
