/**
 * Output tokens per second of the current run, measured over the time assistant messages were streaming.
 *
 * Tool execution and waiting between provider calls are not generation, so a run that spends a minute in a
 * build and two seconds writing does not read as slow. The rate is the run's output tokens over the summed
 * streaming time of its assistant messages, updated each time one finishes; a new run keeps showing the last
 * rate until its first message ends. Driven by session events, never polled.
 */
import type { AgentSessionEvent } from "./agent-session-contracts.ts";

export class GenerationRate {
	private streamingSince: number | undefined;
	/** When the current assistant message started: the fallback for a provider that never streams. */
	private startedAt: number | undefined;
	/** An assistant message has started and has not streamed its first token yet. */
	private awaitingFirstToken = false;
	private runTokens = 0;
	private runStreamingMs = 0;
	private last: number | undefined;

	observe(event: AgentSessionEvent, now = Date.now()): void {
		if (event.type === "agent_start") {
			this.runTokens = 0;
			this.runStreamingMs = 0;
			this.streamingSince = undefined;
			this.startedAt = undefined;
			this.awaitingFirstToken = false;
			return;
		}
		if (event.type === "message_start") {
			if (event.message.role === "assistant") {
				this.awaitingFirstToken = true;
				this.startedAt = now;
			}
			return;
		}
		if (event.type === "message_update") {
			// The first update of an assistant message is its first streamed token: generation starts here.
			if (this.awaitingFirstToken && event.message.role === "assistant") {
				this.awaitingFirstToken = false;
				this.streamingSince = now;
			}
			return;
		}
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const since = this.streamingSince ?? this.startedAt;
		this.streamingSince = undefined;
		this.startedAt = undefined;
		this.awaitingFirstToken = false;
		if (since === undefined) return;
		this.runStreamingMs += Math.max(0, now - since);
		this.runTokens += event.message.usage?.output ?? 0;
		if (this.runStreamingMs > 0 && this.runTokens > 0) this.last = this.runTokens / (this.runStreamingMs / 1000);
	}

	/** Tokens per second of the latest run that generated any, or undefined before the first one. */
	get tokensPerSecond(): number | undefined {
		return this.last;
	}
}
