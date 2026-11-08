import type { Api, Model } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { AuthStorage } from "../auth-storage.ts";
import type { HarnessNoticeKind, HarnessNoticeObservation } from "../harness-notice.ts";

/** Why a worker left the model it was started on: the class the root model and the owner read, never a raw error. */
export type WorkerModelMoveReason = "login_expired" | "quota_exhausted" | "model_unavailable" | "credential_rejected";

/** One move of a worker to the next model of its ordered candidates, as `provider/modelId` references. */
export interface WorkerModelMove {
	readonly from: string;
	readonly to: string;
	readonly reason: WorkerModelMoveReason;
}

const MOVE_REASON_WORDS: Record<WorkerModelMoveReason, string> = {
	login_expired: "login expired; the owner is told, nothing to do",
	quota_exhausted: "quota exhausted",
	model_unavailable: "model unavailable for the account",
	credential_rejected: "credential rejected",
};

/** The start-result line that tells the root model its worker already moved, so it neither probes nor names a model. */
export function describeWorkerModelMoves(moves: readonly WorkerModelMove[] | undefined): string | undefined {
	if (!moves || moves.length === 0) return undefined;
	return moves.map((move) => `moved from ${move.from} to ${move.to} (${MOVE_REASON_WORDS[move.reason]})`).join("; ");
}

/**
 * The text a stored OAuth credential that expired and could not be refreshed fails with at request-auth resolution
 * (auth-storage's `OAuthCredentialUnusableError`, flattened to its message by the model registry).
 */
const OAUTH_CREDENTIAL_UNUSABLE_TEXT = /OAuth credential for .+ expired on .+ and could not be refreshed/i;

export function isOAuthCredentialUnusableText(text: string): boolean {
	return OAUTH_CREDENTIAL_UNUSABLE_TEXT.test(text);
}

const LOGIN_NOTICE_KIND: HarnessNoticeKind = "worker-login";

export interface WorkerCredentialHealthDeps {
	/** Read-only use of the credential store: the stored credential and its no-refresh usability answer. */
	getAuthStorage(): Pick<AuthStorage, "get" | "hasAuth">;
	/** The provider's plain name for the owner (e.g. "Anthropic"). */
	getProviderDisplayName(provider: string): string;
	observeNotice?(kind: HarnessNoticeKind, read: () => HarnessNoticeObservation | undefined): boolean;
}

/**
 * Whether a worker model's account can be used, read from stored credential facts only (no refresh, no request), and
 * the owner's one notice per provider login episode. A login that expired and cannot be refreshed belongs to the
 * provider: the credential store already answers "no usable auth" for it, so routing and ordered fallbacks skip every
 * model on it until the owner signs in again, and nothing is marked that would outlive the new login.
 */
export class WorkerCredentialHealth {
	private readonly deps: WorkerCredentialHealthDeps;
	/** Providers whose expired login this runtime has told the owner about; a later usable credential ends the episode. */
	private readonly told = new Set<string>();

	constructor(deps: WorkerCredentialHealthDeps) {
		this.deps = deps;
	}

	/**
	 * The provider's stored OAuth credential is expired and the store no longer counts it as usable auth: its refresh
	 * token was refused or is absent. An expired credential whose refresh was never tried is not this state.
	 */
	loginExpired(provider: string): boolean {
		const auth = this.deps.getAuthStorage();
		const credential = auth.get(provider);
		return credential?.type === "oauth" && Date.now() >= credential.expires && !auth.hasAuth(provider);
	}

	/** Tell the owner once per login episode that the provider's login expired; `moved` says the worker went elsewhere. */
	tellLoginExpired(model: Model<Api>, moved: boolean): void {
		const provider = model.provider;
		if (!this.told.has(provider)) {
			this.told.add(provider);
			harnessLog.warn("delegation", "a worker model's provider login expired and could not be refreshed", () => ({
				provider,
				reason: "login_expired",
				moved,
			}));
		}
		const name = this.deps.getProviderDisplayName(provider);
		const text = moved
			? `Your ${name} login has expired, so workers use another subscription model. Run /login ${provider} to sign in again.`
			: `Your ${name} login has expired, so a worker on it could not start. Run /login ${provider} to sign in again.`;
		// The delivery id is (session, kind, reason, generation) without the scope, so the reason names the provider: a
		// second provider's expired login is its own episode, not covered by the first provider's saved notice.
		this.deps.observeNotice?.(LOGIN_NOTICE_KIND, () => ({
			scope: provider,
			state: { reason: `login-expired:${provider}`, text },
		}));
	}

	/** The provider's credential resolved again: its expired-login episode ended, so a later expiry is told anew. */
	noteUsable(model: Model<Api>): void {
		if (!this.told.delete(model.provider)) return;
		this.deps.observeNotice?.(LOGIN_NOTICE_KIND, () => ({ scope: model.provider, state: "clear" }));
	}
}

/**
 * The moment a started worker's model is settled: its start credentials resolved (possibly after moves to the next
 * candidates) or failed. The start result waits for it, so it names the model the worker actually runs on.
 */
export class WorkerStartSettlement {
	readonly moves: WorkerModelMove[] = [];
	readonly settled: Promise<readonly WorkerModelMove[]>;
	private readonly resolveSettled: (moves: readonly WorkerModelMove[]) => void;

	constructor() {
		let resolveSettled: ((moves: readonly WorkerModelMove[]) => void) | undefined;
		this.settled = new Promise((resolve) => {
			resolveSettled = resolve;
		});
		this.resolveSettled = resolveSettled!;
	}

	/** Idempotent: the first call settles with the moves recorded so far. */
	settle(): void {
		this.resolveSettled([...this.moves]);
	}
}

/** The settlement's moves, or undefined when `signal` aborts first (the start result then names the admitted model). */
export function awaitWorkerStartSettlement(
	settled: Promise<readonly WorkerModelMove[]>,
	signal: AbortSignal,
): Promise<readonly WorkerModelMove[] | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		void settled.then((moves) => {
			signal.removeEventListener("abort", onAbort);
			resolve(moves);
		});
	});
}
