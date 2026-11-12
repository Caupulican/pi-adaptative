/**
 * One joined machine's chat as the hub keeps it on disk: the words sent to it and the words it answered, each with the
 * link message id (an answer carries the id of the message it answers). It owns the file format only; who is told of an
 * answer is the placer lane's business (`job-client.ts`), not the log's.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readFileTailSync } from "../../kernel/storage/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { MAX_MESSAGE_CHARS } from "./protocol.ts";

const MAX_LOGGED = 200;

export interface LoggedMachineMessage {
	readonly at: number;
	readonly from: "hub" | "machine";
	readonly text: string;
	readonly id?: string;
}

function parseMessage(line: string): LoggedMachineMessage | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (
			!isPlainRecord(value) ||
			typeof value.at !== "number" ||
			(value.from !== "hub" && value.from !== "machine") ||
			typeof value.text !== "string"
		)
			return undefined;
		return {
			at: value.at,
			from: value.from,
			text: value.text,
			...(typeof value.id === "string" ? { id: value.id } : {}),
		};
	} catch {
		return undefined;
	}
}

export class MachineChatLog {
	private readonly dir: string;

	constructor(agentDir: string) {
		this.dir = join(agentDir, "remote", "chats");
	}

	append(machine: string, entry: LoggedMachineMessage): void {
		mkdirSync(this.dir, { recursive: true });
		appendFileSync(this.path(machine), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	}

	read(machine: string): LoggedMachineMessage[] {
		const path = this.path(machine);
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8")
			.split("\n")
			.flatMap((line) => {
				const message = parseMessage(line);
				return message ? [message] : [];
			})
			.slice(-MAX_LOGGED);
	}

	/** A stable, bounded suffix; an incomplete or invalid newer record cannot project an older answer. */
	latestMachineReply(machine: string): LoggedMachineMessage | undefined {
		const path = this.path(machine);
		if (!existsSync(path)) return undefined;
		const { content, truncated } = readFileTailSync(path, MAX_MESSAGE_CHARS * 6 + 4096, "Machine chat log");
		if (content.length === 0) return undefined;
		if (content[content.length - 1] !== 10) throw new Error("Machine chat log ends with an incomplete record.");
		let start = 0;
		if (truncated) {
			const newline = content.indexOf(10);
			if (newline < 0) throw new Error("Machine chat log has no complete bounded record.");
			start = newline + 1;
		}
		const lines = content
			.subarray(start, content.length - 1)
			.toString("utf8")
			.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const message = parseMessage(lines[i]);
			if (!message) throw new Error("Machine chat log contains an invalid newer record.");
			if (message.from === "machine") return message;
		}
		if (truncated) throw new Error("Machine chat log's latest reply is outside the bounded tail.");
		return undefined;
	}

	private path(machine: string): string {
		return join(this.dir, `${machine}.jsonl`);
	}
}
