/** Bounded revision custody over the objects a provider-history request read or retained. */

import { messageContentRevision } from "../../kernel/message-revision.ts";

export const MAX_RETAINED_MESSAGES = 128;
// Durable, sanitized, planned and provider copies plus the carried and transient records they read.
const MAX_DEPENDENCIES = MAX_RETAINED_MESSAGES * 8;

export class ContinuousChatMessageDependencies {
	private readonly revisions = new Map<object, number>();
	private bounded = true;

	get complete(): boolean {
		return this.bounded;
	}

	add(messages: readonly object[]): void {
		if (messages.length > MAX_DEPENDENCIES) {
			this.bounded = false;
			return;
		}
		for (const message of messages) {
			if (!this.keep(message, messageContentRevision(message))) return;
		}
	}

	include(previous: ContinuousChatMessageDependencies): void {
		this.bounded &&= previous.complete;
		for (const [message, revision] of previous.revisions) {
			if (!this.keep(message, revision)) return;
		}
	}

	isCurrent(): boolean {
		for (const [message, revision] of this.revisions) {
			if (messageContentRevision(message) !== revision) return false;
		}
		return true;
	}

	markIncomplete(): void {
		this.bounded = false;
	}

	private keep(message: object, revision: number): boolean {
		if (this.revisions.has(message)) return true;
		if (this.revisions.size >= MAX_DEPENDENCIES) {
			this.bounded = false;
			return false;
		}
		this.revisions.set(message, revision);
		return true;
	}
}
