import type { Readable } from "node:stream";

export const PIPED_STDIN_WAIT_NOTICE_MS = 3_000;

export const PIPED_STDIN_WAIT_NOTICE =
	"Waiting for piped input on standard input (it is not a terminal and has not ended). Close it, or start pi with standard input redirected from /dev/null.";

export interface ReadPipedInputOptions {
	delayMs?: number;
	setTimeout?: (callback: () => void, delayMs: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	writeNotice?: (line: string) => void;
}

function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
	const timer = setTimeout(callback, delayMs);
	timer.unref?.();
	return timer;
}

/** Collect piped UTF-8 input without repeatedly copying the accumulated prefix. */
export async function readPipedInput(
	input: Readable,
	isTTY = false,
	options: ReadPipedInputOptions = {},
): Promise<string | undefined> {
	if (isTTY) return undefined;

	const delayMs = options.delayMs ?? PIPED_STDIN_WAIT_NOTICE_MS;
	const armTimer = options.setTimeout ?? defaultSetTimeout;
	const disarmTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const writeNotice = options.writeNotice ?? ((line) => process.stderr.write(`${line}\n`));

	let timer: unknown;
	let timerCleared = false;
	const clearNoticeTimer = (): void => {
		if (timerCleared) return;
		timerCleared = true;
		if (timer !== undefined) {
			disarmTimer(timer);
			timer = undefined;
		}
	};

	timer = armTimer(() => {
		if (timerCleared) return;
		timerCleared = true;
		timer = undefined;
		writeNotice(PIPED_STDIN_WAIT_NOTICE);
	}, delayMs);

	input.setEncoding("utf8");
	const chunks: string[] = [];
	try {
		for await (const chunk of input) {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (text.length > 0) clearNoticeTimer();
			chunks.push(text);
		}
	} finally {
		clearNoticeTimer();
	}
	const content = chunks.join("").trim();
	return content || undefined;
}
