/**
 * Updates the harness pushes to the owner's own chats (`ownerConversations`, learned from admitted owner messages): at
 * most one push per key ever (the journal's `push:<key>` records, kept a week), `ownerPushPerHour` per channel over a
 * rolling hour and then one line a hour saying how many more wait, each recorded before it is sent (a crash loses a push
 * rather than sending it twice). A push is Pi's own words: bounded to `MAX_OWNER_PUSH_CHARS`, refused when it looks like
 * it holds a secret, and never a third party's message text or a held answer in full. A held draft's presentation is the
 * one longer push (its complete rendering, fenced) and goes only to the chat whose turn held it.
 */

import type { ChannelProvider } from "../gateways/channel-provider.ts";
import { boundedRedactedDiagnosticText, hasMaskableSecretText } from "../security/secret-text.ts";
import { isShippedChannelProvider } from "./built-in-providers.ts";
import { type ChannelJournal, type ChannelOwnerConversation, digest } from "./channel-journal.ts";
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
	now(): number;
	warn(message: string): void;
}

/** How one push is sent: rated (counted against the hourly bound) and to one conversation or every owner chat. */
interface PushOptions {
	readonly rated: boolean;
	/** The one conversation it goes to (a draft presentation); every listed owner chat otherwise. */
	readonly to?: string;
	/** Exempt from `MAX_OWNER_PUSH_CHARS` (a draft presentation). */
	readonly long?: boolean;
}

type PushPlan =
	| { readonly kind: "skip" }
	| { readonly kind: "send"; readonly targets: readonly ChannelOwnerConversation[]; readonly text: string };

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
	 * A held draft's presentation to one chat (the one whose turn held it, or the one asking `status`, then unrated); once
	 * per draft and chat.
	 */
	present(channel: string, draftId: string, text: string, conversationKey: string, rated: boolean): Promise<boolean> {
		return this.send(channel, presentationKey(draftId, conversationKey), text, {
			rated,
			to: conversationKey,
			long: true,
		});
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
				if (pushes.some((entry) => entry.k === k)) return { kind: "skip" };
				const targets = (state.ownerConversations ?? []).filter(
					(conversation) =>
						listed.has(conversation.senderDigest) &&
						(options.to === undefined || conversation.conversationKey === options.to),
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
						};
					}
				}
				state.ownerPushes = [...pushes, { k, at: now, ...(options.to !== undefined ? { c: options.to } : {}) }];
				return { kind: "send", targets, text };
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
		return sent;
	}
}
