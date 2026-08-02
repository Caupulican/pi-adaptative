interface StdinEventSource {
	once(event: "data" | "end" | "error", listener: () => void): unknown;
	removeListener(event: "data" | "end" | "error", listener: () => void): unknown;
}

/** Resolve on terminal input or shutdown and remove every competing listener exactly once. */
export function waitForStdinEvent(input: StdinEventSource = process.stdin): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			input.removeListener("data", finish);
			input.removeListener("end", finish);
			input.removeListener("error", finish);
			resolve();
		};
		input.once("data", finish);
		input.once("end", finish);
		input.once("error", finish);
	});
}
