/**
 * The remote-job delivery model: one placed job seen from its placer and its executor, with the ordered link between them that
 * loses everything in flight when it drops, and the crash of either side. Its actions are named for the real transitions of the
 * job layer (`place`, `replace`, `ask`, `offer.send`, `offer.deliver`, `claim`, `finish`, `scan.interrupt`, `outcome.send`,
 * `outcome.deliver`, `leftover.send`, `leftover.deliver`, `ack.deliver`, `link.up`, `resumePlaced`, `reconcile.apply`,
 * `prune.applied`, ...); each action's comment names the function it models. Its invariants and liveness are the delivery rules the
 * code claims: one admit, one apply, the first outcome wins, an acknowledged outcome is never re-sent, an ask is never an offer, no
 * run without a placed record, a stop reaches the executor, and an outcome is applied only under the turn that carries it. Each
 * variant removes one guard and must break the property that names it. The module imports types only from the job layer, so it
 * loads no runtime module of that layer.
 *
 * Turns: a placed job's id holds its turn (`placedJobId`), so each turn is a job of its own with its own record and executor record.
 * The placer prunes an applied record after its retention; a placement made again after that is the next turn (`replace`), with a new
 * id, a new record and a fresh executor admission. The turn is durable: the placer's turn ledger (`JobStore.raisePlacementTurn`) holds
 * it after the record and the lane binding are released, so `replace` is the only way the turn moves. The executor's record of the spent
 * turn keeps its outbox until the placer acknowledges it: its undrained outcome is a leftover (`leftover`), sent under its own turn, and
 * the placer acknowledges it as absent (`leftover.deliver`) without applying it to the new turn.
 *
 * Ordering: the executor handles every frame of one peer in arrival order, one at a time (`JobTransport.receive`). An offer is first
 * received (`offer.deliver`, the job is then being decided) and decided (`offer.decide`: admitted, replayed or refused); the frames
 * behind it, a stop, an ack or a resume, wait until the decision is made. A stop therefore always finds the job an earlier offer
 * admitted. The variant `stop-overtakes-offer` lets a stop pass a pending decision, and then the stop is handled against no record.
 *
 * Simplifications, stated so the result is read at its real strength: progress frames are not modelled (they carry no outcome);
 * the link keeps order within each direction and loses everything in flight on a drop; a refusal is one token, whatever its
 * reason; the placer's ending by deadline or hold is the unforced `end` action, and the owner's stop is `cancel`. The placer's
 * retention is `prune.applied`, which marks the record gone (`pruned`) and keeps the job's history; it waits for the executor's job to
 * end and for the link to be quiet, since the retention outlasts both (time itself is not modelled). Turns are bounded to two (one
 * re-placement). A resume names the current turn's record only: a leftover's resume is refused as absent by the placer, which changes
 * nothing on a terminal record, so it is not modelled.
 *
 * Connections: the model's `link.up` waits for a pending decision (`!s.deciding`), so the resume names the job that decision admitted. The
code writes the resume after the peer's queued frames (`JobTransport.up`) and lets a placer frame of the new connection queue behind the
decision; the model does not explore that frame's interleaving with the decision, only the resume's. A placer refusal names its turn
(`refuse:<turn>`), a correction the model needed: a refusal of a spent turn names the spent job id, so it is inert for the current turn.

Not modelled (the code has them; the checker sees none of them): the cancel markers beside a record this build cannot read
 * (`RecordDir.cancel`, `honorCancelMark`, `endMarkedPlacement`); unreadable record files and their room bounds
 * (`unreadableHoldingRoom`); the lane book's release of ended lanes (retention) and the lane-end retry alarm (`retryApply`), whose
 * fairness is the `reconcile.apply` action; a stop whose write failed and is applied again at the next flush (`JobHost.heldStops`);
 * a placement's abandoned lanes (`endAbandonedPlacements`); the executor's deadline claim (`scan`, time is not modelled); the
 * placer's pending room held by other sessions (`pendingPlacedCount`); the ledger's growth (one small file per placement key).
 */

import type { ModelAction, ModelSpec } from "../../kernel/machine-model.ts";
import { defineModel } from "../../kernel/machine-model.ts";
import type { ExecutorJobState, PlacerJobState } from "./job-store.ts";

export type Outcome = "-" | "A" | "B";
export type PlacerEntry = PlacerJobState | "none";
export type ExecutorEntry = ExecutorJobState | "none";

/** The most turns one placed job takes: the first placement and one re-placement after a prune. */
const MAX_GENERATION = 2;

/**
 * One placed job. Durable: what a process keeps across a crash. Volatile: what a crash of either side loses with the connection.
 * `toExec` and `toPlacer` are the frames in flight in each direction, oldest first. Tokens: placer to executor `offer`, `cancel`,
 * `ack` (the current turn), `ack:old` (a spent turn's leftover), `refuse:<turn>`, `resume:entry` or `resume:empty`; executor to placer `accept`,
 * `refuse`, `refuse:lost`, `outcome:<A|B>:<turn>`, `resume:entry` or `resume:empty`. An outcome frame names the turn of the record that
 * sent it.
 */
export interface DeliveryState {
	readonly kind: "job" | "ask";
	/** The placement's turn: the turn its job id holds. 0 before the first placement. */
	readonly gen: number;
	readonly p: PlacerEntry;
	readonly pOutcome: Outcome;
	/** The turn of the frame that carried the outcome the placer holds. */
	readonly pOutcomeGen: number;
	/** The first outcome the placer ever took for this turn; the history the first-outcome invariant reads. */
	readonly firstOutcome: Outcome;
	/** Lane ends the placer applied. */
	readonly applied: number;
	/**
	 * The placer pruned its applied record (`JobStore.prune`): the record file is gone. `p`, `applied` and the outcome fields stay as the
	 * history of the turn. A pruned turn answers the executor's frames as absent: a resume is refused, and an outcome is acknowledged
	 * without being kept.
	 */
	readonly pruned: boolean;
	/** The placer's record carries a stop. */
	readonly cancel: boolean;
	/** The stop frame was written to the link (it may still be lost there). */
	readonly cancelSent: boolean;
	/** The executor's record of the current turn. */
	readonly e: ExecutorEntry;
	/** The turn of the executor's record of the current job (the turn of the offer that admitted it); 0 when none. */
	readonly eGen: number;
	readonly eOutcome: Outcome;
	readonly admits: number;
	/** The executor's outbox holds an outcome the placer has not acknowledged. */
	readonly unacked: boolean;
	/** An outcome was written after the placer had acknowledged one: the send step ran without `unacked`. */
	readonly sentAfterAck: boolean;
	readonly ecancel: boolean;
	/**
	 * The executor received an offer and has not decided it yet (`JobHost.offer` awaits its checkouts). The frames behind it wait, unless
	 * the variant lets a stop pass. A crash of the executor loses the decision; a link drop does not.
	 */
	readonly deciding: boolean;
	/** A stop frame was handled for the current turn (`cancel.deliver`, `refuse.stop`): the history the stop invariant reads. */
	readonly stopHandled: boolean;
	/** The running job was claimed by a runner process that is gone: a later runner's scan interrupts it. */
	readonly stale: boolean;
	/**
	 * A spent turn's executor record still holds an outcome the placer has not acknowledged: its frame names the turn before the current one.
	 * The outcome's value is not modelled, since the placer acknowledges such a frame as absent whatever it says.
	 */
	readonly leftover: boolean;
	/** The leftover was written on this connection. */
	readonly loSent: boolean;
	readonly up: boolean;
	/** A live runner session holds this machine's jobs. */
	readonly runner: boolean;
	/** The outcome was written on this connection. */
	readonly sent: boolean;
	/** The offer was written on this connection. */
	readonly offered: boolean;
	readonly toExec: readonly string[];
	readonly toPlacer: readonly string[];
}

/** The mutations the variants apply. The base model has every flag false. */
export interface DeliveryFlags {
	readonly askOffers: boolean;
	readonly askAdmits: boolean;
	readonly replayAdmits: boolean;
	readonly secondFinish: boolean;
	readonly lastWins: boolean;
	readonly applyRepeats: boolean;
	readonly applyAnyState: boolean;
	readonly recordVolatile: boolean;
	readonly resendAcked: boolean;
	readonly resumeKeepsSent: boolean;
	readonly resumeIgnoresEnded: boolean;
	/** The placer that holds no record of an outcome consumes it without acknowledging it (the outbox then never drains). */
	readonly absentSilent: boolean;
	/**
	 * The job id names no turn: a re-placed turn has the id of the one before, so the executor's record of that turn is the one it meets,
	 * and an outcome is matched by id alone (no turn check on the frame).
	 */
	readonly turnNotInId: boolean;
	/** A stop frame is handled while an offer is still being decided: the stop reaches no record, and the decision admits the job anyway. */
	readonly stopsOvertake: boolean;
}

const BASE: DeliveryFlags = {
	askOffers: false,
	askAdmits: false,
	replayAdmits: false,
	secondFinish: false,
	lastWins: false,
	applyRepeats: false,
	applyAnyState: false,
	recordVolatile: false,
	resendAcked: false,
	resumeKeepsSent: false,
	resumeIgnoresEnded: false,
	absentSilent: false,
	turnNotInId: false,
	stopsOvertake: false,
};

const settled = (p: PlacerEntry): boolean => p === "terminal" || p === "ended" || p === "refused";
const live = (e: ExecutorEntry): boolean => e === "admitted" || e === "running";
const isOutcome = (token: string): boolean => token.startsWith("outcome:");
const isResume = (token: string): boolean => token.startsWith("resume");
/** The outcome an outcome frame carries. */
const outcomeOf = (token: string): Outcome => (token.split(":")[1] === "A" ? "A" : "B");
/** The turn an outcome frame was written for. */
const turnOf = (token: string): number => Number(token.split(":")[2]);
/** A placer's refusal that stops the executor's job: `refuse:<turn>`, the turn of the record it refuses. */
const isStopRefusal = (token: string | undefined): boolean => token?.startsWith("refuse:") ?? false;
/** The turn a placer refusal names. A refusal of a spent turn is inert for the current one: its job id is the spent turn's. */
const turnOfRefusal = (token: string): number => Number(token.split(":")[1]);

/** The state a job starts in: nothing placed, no link, a live runner. The kind is fixed for the life of the job. */
function initialState(kind: "job" | "ask"): DeliveryState {
	return {
		kind,
		gen: 0,
		p: "none",
		pOutcome: "-",
		pOutcomeGen: 0,
		firstOutcome: "-",
		applied: 0,
		pruned: false,
		cancel: false,
		cancelSent: false,
		e: "none",
		eGen: 0,
		eOutcome: "-",
		admits: 0,
		unacked: false,
		sentAfterAck: false,
		ecancel: false,
		deciding: false,
		stopHandled: false,
		stale: false,
		leftover: false,
		loSent: false,
		up: false,
		runner: true,
		sent: false,
		offered: false,
		toExec: [],
		toPlacer: [],
	};
}

/** The placer's lane ends and its record: the durable part, unless the variant makes the record volatile. */
const PLACER_DURABLE = [
	"p",
	"pOutcome",
	"pOutcomeGen",
	"firstOutcome",
	"applied",
	"pruned",
	"cancel",
	"cancelSent",
] as const;

/** The actions of the model under `flags`. Every guard reads the state only; every apply returns a new state. */
function deliveryActions(flags: DeliveryFlags): ModelAction<DeliveryState>[] {
	const placeAction: ModelAction<DeliveryState> = {
		// `place`: the placer writes the turn's job pending (`RemoteJobClient.writeLaneAndRecord`, then `createPlaced`). A replay after a crash
		// that lost the record writes the same turn: the turn is durable in the lane book.
		name: "place",
		actor: "placer",
		guard: (s) => s.kind === "job" && s.p === "none",
		apply: (s) => ({ ...s, p: "pending", gen: s.gen || 1 }),
	};
	const actions: ModelAction<DeliveryState>[] = [
		placeAction,
		{
			// `replace`: the same step is placed again after the placer pruned its applied record (`RemoteJobClient.placementTurn`): the turn is
			// spent and the job takes the next one, with a new id, a new record and a fresh admission. The executor's record of the spent turn
			// keeps its undrained outcome as the leftover. Without the turn in the id (`turnNotInId`) the id is the one of the spent turn, so the
			// executor's record stays as it is and the new turn meets it.
			name: "replace",
			actor: "placer",
			guard: (s) => s.kind === "job" && s.pruned && s.gen < MAX_GENERATION && !s.leftover,
			apply: (s) => {
				const fresh: DeliveryState = {
					...s,
					gen: s.gen + 1,
					p: "pending",
					pruned: false,
					applied: 0,
					cancel: false,
					cancelSent: false,
					pOutcome: "-",
					pOutcomeGen: 0,
					firstOutcome: "-",
					stopHandled: false,
				};
				if (flags.turnNotInId) return fresh;
				const spent = s.e === "terminal" && s.unacked;
				return {
					...fresh,
					offered: false,
					leftover: spent,
					loSent: false,
					e: "none",
					eGen: 0,
					eOutcome: "-",
					admits: 0,
					unacked: false,
					sentAfterAck: false,
					ecancel: false,
					stale: false,
					sent: false,
				};
			},
		},
		{
			// `ask`: a conversation turn is written `accepted` and never offered (`RemoteJobClient.ask`). The variant writes it pending.
			name: "ask",
			actor: "placer",
			guard: (s) => s.kind === "ask" && s.p === "none",
			apply: (s) => ({ ...s, p: flags.askOffers ? "pending" : "accepted", gen: 1 }),
		},
		{
			// `offer.send`: flush writes a pending offer once per connection, unless it is cancelled (`JobTransport.flush`).
			name: "offer.send",
			actor: "placer",
			guard: (s) => s.p === "pending" && !s.cancel && !s.offered && s.up,
			apply: (s) => ({ ...s, offered: true, toExec: [...s.toExec, "offer"] }),
		},
		{
			// `offer.deliver`: `JobTransport.receive` takes the offer off the link in arrival order and starts deciding it. The frames behind it
			// wait until `offer.decide` has run.
			name: "offer.deliver",
			actor: "executor",
			guard: (s) => s.up && !s.deciding && s.toExec[0] === "offer",
			apply: (s) => ({ ...s, deciding: true, toExec: s.toExec.slice(1) }),
		},
		{
			// `offer.decide`: `JobHost.offer` once the offer's checkouts are read: admitted, replayed or refused (`decideOffer`).
			name: "offer.decide",
			actor: "executor",
			guard: (s) => s.deciding,
			apply: (s) => decideOffer(s, flags),
		},
		{
			// `accept.deliver`: `job.accept` moves a pending record to accepted (`JobTransport.receive`).
			name: "accept.deliver",
			actor: "placer",
			guard: (s) => s.up && s.toPlacer[0] === "accept",
			apply: (s) => ({
				...s,
				p: s.p === "pending" ? "accepted" : s.p,
				toPlacer: s.toPlacer.slice(1),
			}),
		},
		{
			// `refuse.deliver`: `job.refuse` on a pending record refuses it; `refuse:lost` on an accepted one ends it as remote_lost.
			name: "refuse.deliver",
			actor: "placer",
			guard: (s) => s.up && (s.toPlacer[0] === "refuse" || s.toPlacer[0] === "refuse:lost"),
			apply: (s) => {
				const token = s.toPlacer[0];
				const p: PlacerEntry =
					s.p === "pending" ? "refused" : token === "refuse:lost" && s.p === "accepted" ? "ended" : s.p;
				return { ...s, p, toPlacer: s.toPlacer.slice(1) };
			},
		},
		{
			// `outcome.deliver`: `job.outcome` for the turn the frame names is applied (the first outcome wins) and acknowledged when the
			// placer holds the record. A placer that holds none (never placed, or pruned) keeps nothing and acknowledges it as absent
			// (`JobTransport.receive`). The variant without the turn in the id matches the frame by id alone.
			name: "outcome.deliver",
			actor: "placer",
			guard: (s) =>
				s.up &&
				s.toPlacer[0] !== undefined &&
				isOutcome(s.toPlacer[0]) &&
				(flags.turnNotInId || turnOf(s.toPlacer[0]) === s.gen),
			apply: (s) => {
				const frame = s.toPlacer[0];
				const token = outcomeOf(frame);
				const rest = { ...s, toPlacer: s.toPlacer.slice(1) };
				if (s.p === "none" || s.pruned)
					return flags.absentSilent ? rest : { ...rest, toExec: [...rest.toExec, "ack"] };
				const ack = { ...rest, toExec: [...rest.toExec, "ack"] };
				if (s.pOutcome === "-") {
					return {
						...ack,
						pOutcome: token,
						pOutcomeGen: turnOf(frame),
						firstOutcome: token,
						p: s.p === "ended" ? "ended" : "terminal",
					};
				}
				return flags.lastWins && token !== s.pOutcome
					? { ...ack, pOutcome: token, pOutcomeGen: turnOf(frame) }
					: ack;
			},
		},
		{
			// `ack.deliver`: `job.ack` trims the executor's outbox up to the acknowledged frame (`JobHost.ack`); `ack:old` trims a leftover.
			name: "ack.deliver",
			actor: "executor",
			guard: (s) => s.up && !s.deciding && (s.toExec[0] === "ack" || s.toExec[0] === "ack:old"),
			apply: (s) => {
				const rest = { ...s, toExec: s.toExec.slice(1) };
				if (s.toExec[0] === "ack:old") return { ...rest, leftover: false, loSent: false };
				return { ...rest, unacked: s.e === "terminal" ? false : s.unacked };
			},
		},
		{
			// `cancel.deliver`: `job.cancel` stops an admitted or running job (`JobHost.cancel`, `cancelExecuted`).
			name: "cancel.deliver",
			actor: "executor",
			guard: (s) => s.up && s.toExec[0] === "cancel" && (!s.deciding || flags.stopsOvertake),
			apply: (s) => ({ ...s, ecancel: s.ecancel || live(s.e), stopHandled: true, toExec: s.toExec.slice(1) }),
		},
		{
			// `refuse.stop`: a placer refusal stops the job here: the transport's `job.refuse` path with no placed record names it.
			name: "refuse.stop",
			actor: "executor",
			guard: (s) => s.up && isStopRefusal(s.toExec[0]) && (!s.deciding || flags.stopsOvertake),
			apply: (s) => {
				const current = turnOfRefusal(s.toExec[0]) === s.gen;
				return {
					...s,
					ecancel: current ? s.ecancel || live(s.e) : s.ecancel,
					stopHandled: current || s.stopHandled,
					toExec: s.toExec.slice(1),
				};
			},
		},
		{
			// `resume.deliver`: the placer's resume reaches the executor; an entry for a job it does not hold is refused as lost.
			name: "resume.deliver",
			actor: "executor",
			guard: (s) => s.up && !s.deciding && s.toExec[0] !== undefined && isResume(s.toExec[0]),
			apply: (s) => {
				const entry = s.toExec[0] === "resume:entry";
				return {
					...s,
					toExec: s.toExec.slice(1),
					toPlacer: entry && s.e === "none" ? [...s.toPlacer, "refuse:lost"] : s.toPlacer,
				};
			},
		},
		{
			// `resumePlaced`: the executor's resume reaches the placer (`JobTransport.resumePlaced`). An outcome it holds for an ended
			// or applied job is acknowledged; a job it cannot place, has pruned, or has ended without an outcome is refused. The
			// refusal carries the record's stop in code; the model keeps a refusal as one token.
			name: "resumePlaced",
			actor: "placer",
			guard: (s) => s.up && s.toPlacer[0] !== undefined && isResume(s.toPlacer[0]),
			apply: (s) => {
				const rest = { ...s, toPlacer: s.toPlacer.slice(1) };
				if (s.toPlacer[0] !== "resume:entry") return rest;
				if (s.p === "none" || s.pruned) return { ...rest, toExec: [...rest.toExec, `refuse:${s.gen}`] };
				if (s.applied === 0 && s.p !== "ended") return rest;
				if (s.pOutcome !== "-") return { ...rest, toExec: [...rest.toExec, "ack"] };
				return flags.resumeIgnoresEnded ? rest : { ...rest, toExec: [...rest.toExec, `refuse:${s.gen}`] };
			},
		},
		{
			// `claim`: the runner takes an admitted job (`JobRunner.claim`); a job already stopped is not claimed.
			name: "claim",
			actor: "executor",
			guard: (s) => s.runner && s.e === "admitted" && !s.ecancel,
			apply: (s) => ({ ...s, e: "running", stale: false }),
		},
		{
			// `finish`: the worker's end is appended to the outbox as the one outcome (`JobRunner.finish`). An admitted job that was
			// stopped is finished the same way by the scan.
			name: "finish",
			actor: "executor",
			guard: (s) => s.runner && ((s.e === "running" && !s.stale) || (s.e === "admitted" && s.ecancel)),
			apply: (s) => ({ ...s, e: "terminal", eOutcome: "A", unacked: true, sent: false }),
		},
		{
			// `scan.interrupt`: a running job claimed by an earlier runner process ends as interrupted (`JobRunner.scan`).
			name: "scan.interrupt",
			actor: "executor",
			guard: (s) => s.runner && s.e === "running" && s.stale,
			apply: (s) => ({ ...s, e: "terminal", eOutcome: "B", unacked: true }),
		},
		{
			// `arm`: a new runner process takes the runner role; a job it finds running was claimed by an earlier one (`JobRunner.arm`).
			name: "arm",
			actor: "executor",
			guard: (s) => !s.runner,
			apply: (s) => ({ ...s, runner: true, stale: s.e === "running" }),
		},
		{
			// `outcome.send`: the outbox's outcome is written once per connection (`JobHost.pump`), under the turn of its record.
			name: "outcome.send",
			actor: "executor",
			guard: (s) => s.up && (flags.resendAcked || s.unacked) && !s.sent && s.e === "terminal",
			apply: (s) => ({
				...s,
				sent: true,
				sentAfterAck: s.sentAfterAck || !s.unacked,
				toPlacer: [...s.toPlacer, `outcome:${s.eOutcome === "A" ? "A" : "B"}:${s.eGen}`],
			}),
		},
		{
			// `cancel.send`: flush writes a stop of a placed job once, whatever the state of the offer (`JobTransport.flush`). A pruned
			// record is not listed, so it sends nothing.
			name: "cancel.send",
			actor: "placer",
			guard: (s) => s.up && s.cancel && !s.cancelSent && s.kind === "job" && s.p !== "refused" && !s.pruned,
			apply: (s) => ({ ...s, cancelSent: true, toExec: [...s.toExec, "cancel"] }),
		},
		{
			// `end`: the placer ends a job it no longer waits for, by the deadline or the offline hold (`RemoteJobClient.end`).
			name: "end",
			actor: "placer",
			guard: endable,
			apply: endJob,
		},
		{
			// `cancel`: the owner stops the job (`RemoteJobClient.cancel`, `cancelOn`, then `end`).
			name: "cancel",
			actor: "placer",
			guard: endable,
			apply: endJob,
		},
		{
			// `completeAsk`: the machine's reply to a conversation turn is that turn's outcome (`RemoteJobClient.completeAsk`).
			name: "completeAsk",
			actor: "placer",
			guard: (s) => s.kind === "ask" && s.p === "accepted" && s.up,
			apply: (s) => ({ ...s, p: "terminal", pOutcome: "A", pOutcomeGen: s.gen, firstOutcome: "A" }),
		},
		{
			// `reconcile.apply`: the placer applies a settled job's end to its lane, at most once (`RemoteJobClient.apply`).
			name: "reconcile.apply",
			actor: "placer",
			guard: (s) =>
				(flags.applyAnyState ? s.p !== "none" : settled(s.p)) && s.applied < (flags.applyRepeats ? 2 : 1),
			apply: (s) => ({ ...s, applied: s.applied + 1 }),
		},
		{
			// `prune.applied`: the placer removes an applied record once its retention has passed (`JobStore.prune`), whether or not the
			// executor has acknowledged its outcome. Time is not modelled: the retention outlasts a job's life and every frame in flight,
			// so the prune waits for the executor's job to end (the outbox may still hold its outcome) and for the link to be quiet.
			name: "prune.applied",
			actor: "placer",
			guard: (s) =>
				s.applied >= 1 &&
				!s.pruned &&
				!live(s.e) &&
				!s.deciding &&
				s.toExec.length === 0 &&
				s.toPlacer.length === 0,
			apply: (s) => ({ ...s, pruned: true }),
		},
		{
			// `link.drop`: the connection is lost with everything in flight. Lossy: it consumes the drop budget.
			name: "link.drop",
			actor: "link",
			lossy: true,
			guard: (s) => s.up,
			apply: (s) => ({ ...s, up: false, toExec: [], toPlacer: [] }),
		},
		{
			// `link.up`: a connection is proven; each side resets its per-connection state and sends its resume frame
			// (`JobTransport.up`). The placer's entry is its accepted job; the executor's is a job it still holds or has unacknowledged.
			name: "link.up",
			actor: "link",
			// The connection's resume is computed after the frames queued from the peer (`JobTransport.up`): a decision still pending from the
			// last connection admits its job first, so the resume names it and a stop that was lost with that connection is sent again.
			guard: (s) => !s.up && !s.deciding,
			apply: (s) => ({
				...s,
				up: true,
				sent: flags.resumeKeepsSent ? s.sent : false,
				loSent: false,
				offered: false,
				toExec: [...s.toExec, s.p === "accepted" && s.kind === "job" ? "resume:entry" : "resume:empty"],
				toPlacer: [...s.toPlacer, live(s.e) || (s.e === "terminal" && s.unacked) ? "resume:entry" : "resume:empty"],
			}),
		},
	];
	if (flags.secondFinish) actions.push(secondFinishAction());
	if (!flags.turnNotInId) actions.push(leftoverSendAction(), leftoverDeliverAction(flags));
	return actions;
}

/**
 * `offer.decide`: `JobHost.offer` once the offer is received and its checkouts are read. A record the executor holds answers the offer as a
 * resend would: `accept` for a running or admitted job, or a finished one whose outcome is still held (the pump resends it); a finished job
 * whose outcome the placer acknowledged is refused, so the placer never waits for an outcome that will not come. A new offer is admitted or
 * refused (an ask is never admitted). The reply leaves only while the connection is up; the admission does not depend on it.
 */
function decideOffer(s: DeliveryState, flags: DeliveryFlags): DeliveryState | readonly DeliveryState[] {
	const decided: DeliveryState = { ...s, deciding: false };
	const reply = (token: string): string[] => (s.up ? [...s.toPlacer, token] : [...s.toPlacer]);
	if (s.e !== "none") {
		if (s.e === "terminal" && !s.unacked) return { ...decided, toPlacer: reply("refuse") };
		return { ...decided, admits: flags.replayAdmits ? s.admits + 1 : s.admits, toPlacer: reply("accept") };
	}
	const refusal: DeliveryState = { ...decided, toPlacer: reply("refuse") };
	if (s.kind === "ask" && !flags.askAdmits) return refusal;
	return [{ ...decided, e: "admitted", eGen: s.gen, admits: s.admits + 1, toPlacer: reply("accept") }, refusal];
}

/** A placed job the placer can still end: nothing applied yet, and not already ended, refused or settled. */
const endable = (s: DeliveryState): boolean => s.applied === 0 && (s.p === "pending" || s.p === "accepted");
/** The placer's end of a job: the record is ended and the stop is kept, so the stop frame is written once. */
const endJob = (s: DeliveryState): DeliveryState => ({ ...s, p: "ended", cancel: true });

/** The variant-only producer of a second, different outcome (the code's `appendOutbox` refuses a second one). */
function secondFinishAction(): ModelAction<DeliveryState> {
	return {
		name: "finish.second",
		actor: "executor",
		guard: (s) => s.e === "terminal" && s.eOutcome === "A",
		apply: (s) => ({ ...s, eOutcome: "B", unacked: true, sent: false }),
	};
}

/** The spent turn's outbox outcome is written once per connection (`JobHost.pump` over the spent turn's record). */
function leftoverSendAction(): ModelAction<DeliveryState> {
	return {
		name: "leftover.send",
		actor: "executor",
		guard: (s) => s.up && s.leftover && !s.loSent,
		apply: (s) => ({ ...s, loSent: true, toPlacer: [...s.toPlacer, `outcome:A:${s.gen - 1}`] }),
	};
}

/**
 * A frame of a spent turn meets no record of its id: the placer acknowledges it as absent, never keeps it (`JobTransport.receive`), so
 * the leftover drains and the new turn never sees it.
 */
function leftoverDeliverAction(flags: DeliveryFlags): ModelAction<DeliveryState> {
	return {
		name: "leftover.deliver",
		actor: "placer",
		guard: (s) => s.up && s.toPlacer[0] !== undefined && isOutcome(s.toPlacer[0]) && turnOf(s.toPlacer[0]) !== s.gen,
		apply: (s) => {
			const rest = { ...s, toPlacer: s.toPlacer.slice(1) };
			return flags.absentSilent ? rest : { ...rest, toExec: [...rest.toExec, "ack:old"] };
		},
	};
}

/** The crash of either side: what the process held is lost with the connection; a runner's crash ends its runner role. */
const CRASHES = [
	{ actor: "placer", volatile: { up: false, offered: false, toExec: [], toPlacer: [] } },
	{
		actor: "executor",
		volatile: { up: false, runner: false, sent: false, loSent: false, deciding: false, toExec: [], toPlacer: [] },
	},
] as const;

function durableKeys(flags: DeliveryFlags): (keyof DeliveryState)[] {
	const placer: readonly (keyof DeliveryState)[] = flags.recordVolatile ? [] : PLACER_DURABLE;
	return [
		"kind",
		"gen",
		"e",
		"eGen",
		"eOutcome",
		"admits",
		"unacked",
		"sentAfterAck",
		"ecancel",
		"stopHandled",
		"stale",
		"leftover",
		...placer,
	];
}

/** Builds the model under `flags`. The variants are passed in so every variant is checked against the same property names. */
export function buildDeliveryModel(
	flags: DeliveryFlags,
	variants: ModelSpec<DeliveryState>["variants"],
): ModelSpec<DeliveryState> {
	const actions = deliveryActions(flags);
	const placerVolatile = flags.recordVolatile
		? {
				p: "none" as const,
				pOutcome: "-" as const,
				pOutcomeGen: 0,
				firstOutcome: "-" as const,
				applied: 0,
				pruned: false,
				cancel: false,
				cancelSent: false,
			}
		: {};
	const crashes = CRASHES.map((entry) =>
		entry.actor === "placer" ? { actor: "placer", volatile: { ...entry.volatile, ...placerVolatile } } : { ...entry },
	);
	return defineModel<DeliveryState>({
		name: "remote-job-delivery",
		vars: {
			durable: durableKeys(flags),
			volatile: {
				up: false,
				runner: true,
				sent: false,
				offered: false,
				loSent: false,
				deciding: false,
				toExec: [],
				toPlacer: [],
				...(flags.recordVolatile ? { ...placerVolatile } : {}),
			},
		},
		init: [initialState("job"), initialState("ask")],
		actions,
		crashes,
		invariants: [
			{ name: "admit-once", holds: (s) => s.admits <= 1, brokenVariant: "admit-without-lock" },
			{ name: "apply-once", holds: (s) => s.applied <= 1, brokenVariant: "apply-without-appliedAt" },
			{
				name: "first-outcome-wins",
				holds: (s) => s.firstOutcome === "-" || s.pOutcome === s.firstOutcome,
				brokenVariant: "last-outcome-wins",
			},
			{
				// The outcome the placer holds came from the turn it is placed for: an outcome of an earlier turn is never its result.
				name: "no-cross-generation-apply",
				holds: (s) => s.pOutcome === "-" || s.pOutcomeGen === s.gen,
				brokenVariant: "turn-not-in-id",
			},
			{
				name: "ask-never-offered",
				holds: (s) => s.kind === "job" || s.e === "none",
				brokenVariant: "ask-places-offer",
			},
			{
				name: "apply-after-settle",
				holds: (s) => s.applied === 0 || settled(s.p),
				brokenVariant: "apply-on-accepted",
			},
			{
				name: "no-run-without-record",
				holds: (s) => !live(s.e) || s.p !== "none",
				brokenVariant: "record-volatile",
			},
			{ name: "ack-never-resent", holds: (s) => !s.sentAfterAck, brokenVariant: "resend-after-ack" },
			{
				// A stop handled for a turn reaches the job it stops: no job admitted under the turn runs on without it.
				name: "stop-after-offer-reaches-job",
				holds: (s) => !(s.stopHandled && live(s.e) && !s.ecancel),
				brokenVariant: "stop-overtakes-offer",
			},
		],
		liveness: [
			{
				// Weak fairness on every delivery, send and resume, and on the local steps that always eventually happen (the runner
				// claims, finishes, interrupts and re-arms; the placer applies a settled job and completes an ask).
				name: "delivery-applies",
				goal: (s) => s.applied >= 1,
				fair: [
					"place",
					"ask",
					"*.deliver",
					"*.send",
					"refuse.stop",
					"resumePlaced",
					"link.up",
					"reconcile.apply",
					"offer.decide",
					"claim",
					"finish",
					"scan.interrupt",
					"arm",
					"completeAsk",
				],
				brokenVariant: "resume-skips-unacked",
			},
			{
				// The outbox drains: an outcome the executor holds, the current turn's or a spent turn's, is eventually acknowledged by the
				// placer, also after the placer pruned its record (the outcome then meets an absent record, which acknowledges it).
				name: "outcome-acked",
				goal: (s) => !(s.e === "terminal" && s.unacked) && !s.leftover,
				fair: ["*.deliver", "*.send", "refuse.stop", "resumePlaced", "link.up", "offer.decide"],
				brokenVariant: "absent-unacked",
			},
			{
				// The runner's own completion is not forced here: a stop must reach the executor by itself, not through the job's end.
				name: "stop-reaches-executor",
				goal: (s) => !(s.cancel && !s.ecancel && live(s.e)),
				fair: ["*.deliver", "*.send", "refuse.stop", "resumePlaced", "link.up", "offer.decide"],
				brokenVariant: "resume-ignores-ended",
			},
		],
		terminal: (s) =>
			s.applied >= 1 &&
			s.toExec.length === 0 &&
			s.toPlacer.length === 0 &&
			(s.e === "none" || s.e === "terminal") &&
			!s.unacked &&
			!s.leftover,
		bounds: { maxStates: 900000, maxCrashes: 2, maxDrops: 2 },
		covers: [
			{
				path: "core/remote/job-store.ts",
				symbols: ["admit", "appendOutbox", "createPlaced", "updatePlaced", "cancelExecuted", "prune"],
			},
			{
				path: "core/remote/job-host.ts",
				symbols: ["offer", "decide", "offerFailed", "cancel", "resumeEntries", "pump"],
			},
			{
				path: "core/remote/job-transport.ts",
				symbols: ["receive", "handle", "placerFrame", "resumePlaced", "flush", "refused"],
			},
			{ path: "core/remote/job-runner.ts", symbols: ["claim", "finish", "scan", "arm", "observe"] },
			{
				path: "core/remote/job-client.ts",
				symbols: [
					"placementTurn",
					"writeLaneAndRecord",
					"completeAsk",
					"honorCancelMark",
					"endAbandonedPlacements",
					"reconcile",
				],
			},
			{ path: "core/remote/outcome-adapter.ts", symbols: ["placedJobTerminal"] },
			{ path: "core/remote/job-protocol.ts", symbols: ["digestOffer", "parseJobFrame"] },
		],
		variants,
		machine: { states: (s) => s.p, events: actions.map((action) => action.name) },
	});
}

/** The variants: one mutation each, named for the property it must break. The map is checked by `scripts/check-machine-models.mjs`. */
export const deliveryVariants: ModelSpec<DeliveryState>["variants"] = {
	"admit-without-lock": () => buildDeliveryModel({ ...BASE, replayAdmits: true }, deliveryVariants),
	"apply-without-appliedAt": () => buildDeliveryModel({ ...BASE, applyRepeats: true }, deliveryVariants),
	"last-outcome-wins": () => buildDeliveryModel({ ...BASE, secondFinish: true, lastWins: true }, deliveryVariants),
	"ask-places-offer": () => buildDeliveryModel({ ...BASE, askOffers: true, askAdmits: true }, deliveryVariants),
	"apply-on-accepted": () => buildDeliveryModel({ ...BASE, applyAnyState: true }, deliveryVariants),
	"record-volatile": () => buildDeliveryModel({ ...BASE, recordVolatile: true }, deliveryVariants),
	"resend-after-ack": () => buildDeliveryModel({ ...BASE, resendAcked: true }, deliveryVariants),
	"resume-skips-unacked": () => buildDeliveryModel({ ...BASE, resumeKeepsSent: true }, deliveryVariants),
	"resume-ignores-ended": () => buildDeliveryModel({ ...BASE, resumeIgnoresEnded: true }, deliveryVariants),
	"absent-unacked": () => buildDeliveryModel({ ...BASE, absentSilent: true }, deliveryVariants),
	"turn-not-in-id": () => buildDeliveryModel({ ...BASE, turnNotInId: true }, deliveryVariants),
	"stop-overtakes-offer": () => buildDeliveryModel({ ...BASE, stopsOvertake: true }, deliveryVariants),
};

/** The model the checker explores and the journal's chart projects. */
export const remoteJobDeliveryModel: ModelSpec<DeliveryState> = buildDeliveryModel(BASE, deliveryVariants);

/**
 * The properties a variant may break beyond the one that names it, each with its reason. A record lost to a crash cannot apply the
 * job's end; its outcome then meets an absent record and is acknowledged, so the outbox still drains. An offered ask is never stopped
 * on the live connection: the stop is written only for jobs (`cancel.send`), so the ask variant also breaks the stop property. A
 * dropped outcome that was sent is never resent when the resume keeps `sent`, so that variant also leaves the outbox undrained. A stop
 * that passes a pending decision finds no record: the job then runs without its stop, and the placer, which marked the stop sent, never
 * sends it again, so `stop-overtakes-offer` also leaves a stopped job unstopped. Without
 * the turn in the id, a re-placed turn keeps the offered mark its connection already holds for that id, so it is never offered on that
 * connection and no run starts for it: the placer waits with nothing in flight.
 */
export const DELIVERY_CASCADES: Readonly<Record<string, readonly string[]>> = {
	"record-volatile": ["delivery-applies"],
	"ask-places-offer": ["stop-reaches-executor"],
	"resume-skips-unacked": ["outcome-acked"],
	"turn-not-in-id": ["delivery-applies"],
	"stop-overtakes-offer": ["stop-reaches-executor"],
};
