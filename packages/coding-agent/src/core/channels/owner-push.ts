/**
 * Updates the harness pushes to the owner's own chats (`ownerConversations`, learned from admitted owner messages): at
 * most one push per key ever (the journal's `push:<key>` records, kept a week), `ownerPushPerHour` per channel over a
 * rolling hour and then one line a hour saying how many more wait, each recorded before it is sent (a crash loses a push
 * rather than sending it twice). A push is Pi's own words: bounded to `MAX_OWNER_PUSH_CHARS`, refused when it looks like
 * it holds a secret, and never a third party's message text or a held answer in full. A held draft's presentation is the
 * one longer push (its complete rendering, fenced) and goes only to the chat whose turn held it.
 *
 * A notice (`tell`) is the one kind of push a session sends about work no phone turn opened: its caller writes the
 * words (a waiting call's notice carries the line the session's status shows that call by). Only the session that
 * serves a channel sends on it, so a notice from any other session of the agent directory waits in the channel's
 * journal and the serving session sends it as that key's push (`drain`): at once when the journal directory's watch
 * tells it, and at its next channel pass otherwise.
 */

import type { ChannelChoice, ChannelProvider } from "../gateways/channel-provider.ts";
import { boundedRedactedDiagnosticText, hasMaskableSecretText } from "../security/secret-text.ts";
import { isShippedChannelProvider } from "./built-in-providers.ts";
import {
	type ChannelJournal,
	type ChannelJournalState,
	type ChannelOwnerConversation,
	type ChannelOwnerNoticeRecord,
	digest,
} from "./channel-journal.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import { listedOwnerDigests } from "./owner-channel.ts";

/** The longest push but a draft presentation. */
export const MAX_OWNER_PUSH_CHARS = 600;
const HOUR_MS = 60 * 60 * 1000;
const OVERFLOW_PREFIX = "push:overflow:";

/** What a push needs of the channels core that hosts it. */
export interface OwnerPushHost {
	journal(channel: string): ChannelJournal;
	provider(channel: string): ChannelProvider | undefined;
	/** The policy while the channel carries owner authority in this session (wired, shipped, listed); else undefined. */
	ownerPolicy(channel: string): ResolvedChannelPolicy | undefined;
	/** The channels that carry owner authority in this session. */
	ownerChannels(): readonly string[];
	/** Whether this session serves `channel` with its transport started: the only session that sends on it. */
	serves(channel: string): boolean;
	now(): number;
	warn(message: string): void;
}

/** How one push is sent: rated (counted against the hourly bound) and to one conversation or every owner chat. */
interface PushOptions {
	readonly rated: boolean;
	/** The one conversation it goes to (a draft presentation); every listed owner chat otherwise. */
	readonly to?: string;
	/** With `to`: the sender digest that conversation must have been learned from. */
	readonly from?: string;
	/** Exempt from `MAX_OWNER_PUSH_CHARS` (a draft presentation). */
	readonly long?: boolean;
	/** One-tap answers under the push (a draft presentation's two decisions), where the transport shows them. */
	readonly choices?: readonly ChannelChoice[];
}

type PushPlan =
	| { readonly kind: "skip" }
	| {
			readonly kind: "send";
			readonly targets: readonly ChannelOwnerConversation[];
			readonly text: string;
			/** Whether this send is the push itself (it carries the choices) or the line that says more are waiting. */
			readonly own: boolean;
	  };

function presentationKey(draftId: string, conversationKey: string): string {
	return `draft:${draftId}:${digest(conversationKey).slice(0, 12)}`;
}

function bounded(text: string): string {
	return text.length > MAX_OWNER_PUSH_CHARS ? `${text.slice(0, MAX_OWNER_PUSH_CHARS - 1)}…` : text;
}

export class OwnerPush {
	private readonly host: OwnerPushHost;

	constructor(host: OwnerPushHost) {
		this.host = host;
	}

	/** Push `text` once for `key` to every owner chat of `channel`; resolves whether it was sent. */
	push(channel: string, key: string, text: string): Promise<boolean> {
		return this.send(channel, key, bounded(text), { rated: true });
	}

	/**
	 * A held draft's presentation to one chat of `senderDigest` (the one whose turn held it, or the one asking `status`,
	 * then unrated). It counts as shown only once the send resolved; `status` sends again one recorded but never shown.
	 */
	present(
		channel: string,
		draftId: string,
		presentation: { readonly text: string; readonly choices: readonly ChannelChoice[] },
		conversationKey: string,
		senderDigest: string,
		rated: boolean,
	): Promise<boolean> {
		return this.send(channel, presentationKey(draftId, conversationKey), presentation.text, {
			rated,
			to: conversationKey,
			from: senderDigest,
			long: true,
			...(presentation.choices.length > 0 ? { choices: presentation.choices } : {}),
		});
	}

	/** Whether any channel carries owner authority in this session now. */
	hasOwnerChannel(): boolean {
		return this.host.ownerChannels().length > 0;
	}

	/**
	 * Tell the owner once for `key` on every channel that carries owner authority in this session: pushed at once where
	 * this session serves the channel, and left in the channel's journal for the session that does otherwise.
	 */
	tell(key: string, text: string): void {
		const said = bounded(text);
		if (hasMaskableSecretText(said)) return;
		for (const channel of this.host.ownerChannels()) {
			if (this.host.serves(channel)) void this.send(channel, key, said, { rated: true });
			else if (!this.left(channel).some((notice) => notice.key === key))
				this.changeNotices(channel, (notices, state) =>
					state.ownerPushes?.some((entry) => entry.k === `push:${key}`)
						? notices
						: [...notices, { key, text: said, at: this.host.now() }],
				);
		}
	}

	/** Take back a notice no session sent yet: what it told of no longer waits. A sent one stays sent. */
	retract(key: string): void {
		for (const channel of this.host.ownerChannels())
			if (this.left(channel).some((notice) => notice.key === key))
				this.changeNotices(channel, (notices) => notices.filter((notice) => notice.key !== key));
	}

	/** Send the notices left for the owner on a channel this session serves, oldest first, each as its key's push. */
	async drain(channel: string): Promise<void> {
		if (!this.host.serves(channel) || !this.host.ownerPolicy(channel) || this.left(channel).length === 0) return;
		let taken: readonly ChannelOwnerNoticeRecord[] = [];
		// Taken before they are sent, like a push's own record: a crash loses a notice rather than sending it twice.
		this.changeNotices(channel, (notices) => {
			taken = notices;
			return [];
		});
		for (const notice of taken) await this.send(channel, notice.key, notice.text, { rated: true });
	}

	/** The notices waiting in the channel's journal, read without its lock. */
	private left(channel: string): readonly ChannelOwnerNoticeRecord[] {
		return this.host.journal(channel).read().result.ownerNotices ?? [];
	}

	private changeNotices(
		channel: string,
		change: (
			notices: readonly ChannelOwnerNoticeRecord[],
			state: ChannelJournalState,
		) => readonly ChannelOwnerNoticeRecord[],
	): void {
		try {
			this.host.journal(channel).update(this.host.now(), (state) => {
				const next = change(state.ownerNotices ?? [], state);
				state.ownerNotices = next.length > 0 ? [...next] : undefined;
			});
		} catch (error) {
			this.host.warn(
				`Channel ${channel}: a notice for the owner was not recorded (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
	}

	/** When the presentation of `draftId` was sent to `conversationKey`; undefined if it never was. */
	presentedAt(channel: string, draftId: string, conversationKey: string): number | undefined {
		const k = `push:${presentationKey(draftId, conversationKey)}`;
		return this.host
			.journal(channel)
			.read()
			.result.ownerPushes?.find((entry) => entry.k === k && entry.c === conversationKey)?.at;
	}

	/** Updates the hourly bound kept from the owner since the last `status`; the count is cleared by the read. */
	takeSuppressed(channel: string): number {
		return this.host.journal(channel).update(this.host.now(), (state) => {
			const count = state.ownerPushSuppressed ?? 0;
			state.ownerPushSuppressed = undefined;
			return count;
		}).result;
	}

	private async send(channel: string, key: string, text: string, options: PushOptions): Promise<boolean> {
		const policy = this.host.ownerPolicy(channel);
		const provider = this.host.provider(channel);
		if (!policy || !provider || hasMaskableSecretText(text)) return false;
		if (!options.long && text.length > MAX_OWNER_PUSH_CHARS) return false;
		const now = this.host.now();
		const listed = listedOwnerDigests(channel, policy, provider);
		const k = `push:${key}`;
		let plan: PushPlan;
		try {
			plan = this.host.journal(channel).update(now, (state): PushPlan => {
				const pushes = state.ownerPushes ?? [];
				// A presentation recorded but never shown (its send failed or the process ended) is sent again by `status`.
				const existing = pushes.find((entry) => entry.k === k);
				if (existing && (options.to === undefined || options.rated || existing.c !== undefined))
					return { kind: "skip" };
				const targets = (state.ownerConversations ?? []).filter(
					(conversation) =>
						listed.has(conversation.senderDigest) &&
						(options.to === undefined || conversation.conversationKey === options.to) &&
						(options.from === undefined || conversation.senderDigest === options.from),
				);
				if (targets.length === 0) return { kind: "skip" };
				if (options.rated) {
					if (policy.ownerPushPerHour === 0) return { kind: "skip" };
					const recent = pushes.filter((entry) => now - entry.at < HOUR_MS);
					const rated = recent.filter((entry) => !entry.k.startsWith(OVERFLOW_PREFIX));
					if (rated.length >= policy.ownerPushPerHour) {
						const suppressed = (state.ownerPushSuppressed ?? 0) + 1;
						state.ownerPushSuppressed = suppressed;
						if (recent.some((entry) => entry.k.startsWith(OVERFLOW_PREFIX))) return { kind: "skip" };
						state.ownerPushes = [...pushes, { k: `${OVERFLOW_PREFIX}${now}`, at: now }];
						return {
							kind: "send",
							targets,
							text: `${suppressed} more update(s) waiting past channels.${channel}.ownerPushPerHour; send status.`,
							own: false,
						};
					}
				}
				if (!existing) state.ownerPushes = [...pushes, { k, at: now }];
				return { kind: "send", targets, text, own: true };
			}).result;
		} catch (error) {
			this.host.warn(
				`Channel ${channel}: an update for the owner was not recorded (${error instanceof Error ? error.message : String(error)}); it is not sent.`,
			);
			return false;
		}
		if (plan.kind === "skip") return false;
		let sent = false;
		for (const target of plan.targets) {
			try {
				await provider.send({
					conversationKey: target.conversationKey,
					address: target.address,
					text: plan.text,
					kind: "message",
					eventId: `push:${digest(`${k}:${target.conversationKey}`).slice(0, 16)}`,
					...(plan.own && options.choices && provider.capabilities?.choices ? { choices: options.choices } : {}),
				});
				sent = true;
			} catch (error) {
				// Only a shipped transport's error is shown: its text is Pi's own words.
				const said = isShippedChannelProvider(provider)
					? boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error))
					: undefined;
				this.host.warn(`Channel ${channel}: an update for the owner was not sent${said ? ` (${said})` : ""}.`);
			}
		}
		if (sent && options.to !== undefined) this.markShown(channel, k, options.to);
		return sent;
	}

	/** A presentation's send resolved: from now on it counts as shown to `conversationKey`, at this time. */
	private markShown(channel: string, k: string, conversationKey: string): void {
		try {
			this.host.journal(channel).update(this.host.now(), (state) => {
				const entry = state.ownerPushes?.find((push) => push.k === k);
				if (!entry) return;
				entry.c = conversationKey;
				entry.at = this.host.now();
			});
		} catch (error) {
			this.host.warn(
				`Channel ${channel}: a shown held action was not recorded (${error instanceof Error ? error.message : String(error)}); status shows it again.`,
			);
		}
	}
}
