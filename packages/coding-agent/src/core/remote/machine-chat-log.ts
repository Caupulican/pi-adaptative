/**
 * One joined machine's chat as the hub keeps it on disk: the words sent to it and the words it answered, each with the
 * link message id (an answer carries the id of the message it answers). It owns the file format only; who is told of an
 * answer is the placer lane's business (`job-client.ts`), not the log's.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainRecord } from "../util/value-guards.ts";

const MAX_LOGGED = 200;

export interface LoggedMachineMessage {
	readonly at: number;
	readonly from: "hub" | "machine";
	readonly text: string;
	readonly id?: string;
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
			.flatMap((line): LoggedMachineMessage[] => {
				try {
					const value: unknown = JSON.parse(line);
					return isPlainRecord(value) &&
						typeof value.at === "number" &&
						(value.from === "hub" || value.from === "machine") &&
						typeof value.text === "string"
						? [
								{
									at: value.at,
									from: value.from,
									text: value.text,
									...(typeof value.id === "string" ? { id: value.id } : {}),
								},
							]
						: [];
				} catch {
					return [];
				}
			})
			.slice(-MAX_LOGGED);
	}

	private path(machine: string): string {
		return join(this.dir, `${machine}.jsonl`);
	}
}
