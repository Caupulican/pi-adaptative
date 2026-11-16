/**
 * What defines a bot's session and whether its model may run now: where the record answers (the session it defines, or a
 * worker's run), the definition's key a session was built on, and the admission every run of the session passes, before
 * the session is built and at the start of each run, whatever opened it. Read again at each ask: the owner's policy, a
 * profile and its pins change without a record change announcing it.
 */
import type { Api, Model } from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";
import { unpricedModelWords } from "../cost/session-turn-spend-bound.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { type BotModelRefusal, BotModelRefusedError } from "./bot-model-refusal.ts";
import { BotOwnerError } from "./bot-owner-error.ts";
import type { BotSender } from "./bot-session-host.ts";
import {
	type BotSessionDefinition,
	botMayRunAsSession,
	ownBotSession,
	ownBotSessionKey,
	profileBotSession,
} from "./bot-session-profile.ts";
import { botSpendCeilingsOn } from "./bot-session-spend.ts";
import type { BotSpendCeiling } from "./bot-session-turns.ts";

/** The root a bot's session is defined for: the directory a bot of its own works in, and what a profile compiles to there. */
export type BotSessionRoot = Pick<BotSender, "cwd" | "compileProfile">;

/** What the admission reads from the host. */
export interface BotSessionAdmissionPorts {
	store(): PersistentBotTeamStore;
	modelRegistry(): ModelRegistry;
	/** Why the worker admission refuses the bot's model now (`BotSessionHostPorts.modelRefusal`). */
	modelRefusal(record: PersistentBotRecord, model: Model<Api>): BotModelRefusal | undefined;
	spendCeilings(): readonly BotSpendCeiling[];
	/** A run was refused on what no longer defines the session: the host applies the record again (`applyRecordChange`). */
	recheck(record: PersistentBotRecord): void;
}

export class BotSessionAdmission {
	private readonly ports: BotSessionAdmissionPorts;

	constructor(ports: BotSessionAdmissionPorts) {
		this.ports = ports;
	}

	/**
	 * Whether the bot's model may run now: the worker admission's rules for an explicitly requested model (read again each
	 * time, since the owner's policy changes), and a model that declares a price when a dollar bound applies. Asked before a
	 * session is built, and by the session at the start of every run, whatever opened it (the owner, a wake). A bot made
	 * from a profile is compiled again: a run on a session built from an older definition (a profile, pin or policy that
	 * changed since, which no record change announces) is refused, and the idle session is rebuilt on the new one. A run
	 * on another model than the one the bot is defined on is refused, and so is one on a model that cannot run now.
	 */
	admit(
		agentId: string,
		model: Model<Api> | undefined,
		built: Pick<BotSessionDefinition, "key" | "spendBudget">,
		builtFor: BotSessionRoot,
	): void {
		const record = this.ports.store().getBot(agentId);
		if (!record || !model) throw new BotOwnerError((text) => text.botTeam.botMissing(agentId));
		const defined = this.route(record, builtFor);
		// A record that left the session path (a leader's, a leader, a profile only a worker's run holds) runs here no more:
		// the session is released once its work settles, and its messages go to a worker.
		if (defined === "worker") {
			queueMicrotask(() => this.ports.recheck(record));
			throw new BotOwnerError((text) => text.botTeam.botRunsAsWorker(agentId));
		}
		if (defined.key !== built.key) {
			queueMicrotask(() => this.ports.recheck(record));
			throw new BotOwnerError((text) => text.botTeam.botSessionOutdated(agentId));
		}
		// The session never leaves its model (`pinnedModel`); a run on any other is refused, never moved.
		if (!modelsAreEqual(model, defined.model))
			throw new BotOwnerError((text) =>
				text.botTeam.botModelMoved(
					agentId,
					`${model.provider}/${model.id}`,
					`${defined.model.provider}/${defined.model.id}`,
				),
			);
		const refusal = this.modelRefusal(record, { model, spendBudget: built.spendBudget });
		if (refusal) throw new BotModelRefusedError(agentId, refusal);
	}

	/**
	 * Why the model may not run now under the record's rules and the bound that applies; undefined when it may. A metered
	 * model that declares no price is refused while a dollar ceiling holds it (`botSpendCeilingsOn`): its requests cannot
	 * be priced against it. A subscription model with no price is held by none, so none refuses it.
	 */
	modelRefusal(
		record: PersistentBotRecord,
		{ model, spendBudget }: Pick<BotSessionDefinition, "model" | "spendBudget">,
	): BotModelRefusal | undefined {
		if (record.profileId === undefined) {
			const refused = this.ports.modelRefusal(record, model);
			if (refused) return refused;
		}
		const bounded = botSpendCeilingsOn(this.ports.spendCeilings(), spendBudget, model, this.ports.modelRegistry());
		const unpriced = bounded.length === 0 ? undefined : unpricedModelWords(model);
		return unpriced === undefined ? undefined : { cause: "model_unpriced", words: unpriced };
	}

	/**
	 * Where the record answers now: the session it defines (a bot of its own on its record, a bot made from a profile on
	 * what the worker resolution compiles for it), or a worker's run (`runsAsSession` false). Throws the owner's words when
	 * it would run as a session and cannot.
	 */
	route(record: PersistentBotRecord, sender: BotSessionRoot): BotSessionDefinition | "worker" {
		if (!botMayRunAsSession(record)) return "worker";
		const { profileId } = record;
		if (profileId === undefined) return ownBotSession(record, sender.cwd(), this.ports.modelRegistry());
		const compiled = sender.compileProfile({ ...record, profileId });
		if (!compiled.ok)
			throw new BotOwnerError((text) =>
				text.botTeam.botProfileRefused(record.agentId, profileId, compiled.skipReason),
			);
		const session = profileBotSession(compiled);
		return session.route === "worker" ? "worker" : session.definition;
	}

	/** The session the record defines now; throws the owner's words when it cannot run as one. */
	define(record: PersistentBotRecord, sender: BotSessionRoot): BotSessionDefinition {
		const defined = this.route(record, sender);
		if (defined === "worker") throw new BotOwnerError((text) => text.botTeam.botRunsAsWorker(record.agentId));
		return defined;
	}

	/** What defines the bot's session now; a bot of its own's is read from its record alone. */
	keyOf(record: PersistentBotRecord, sender: BotSessionRoot): string {
		return record.profileId === undefined ? ownBotSessionKey(record) : this.define(record, sender).key;
	}

	/** What defines the bot's session now; undefined when its profile no longer admits it as one (it is refused when opened). */
	currentKey(record: PersistentBotRecord, sender: BotSessionRoot): string | undefined {
		try {
			return this.keyOf(record, sender);
		} catch {
			return undefined;
		}
	}
}
