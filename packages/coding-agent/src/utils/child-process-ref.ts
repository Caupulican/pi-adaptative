import type { ChildProcess } from "node:child_process";

/** Toggle every handle owned by a child so idle processes do not keep one-shot CLI modes alive. */
export function setChildProcessLoopRef(child: ChildProcess, active: boolean): void {
	const streams = [child.stdin, child.stdout, child.stderr] as unknown as Array<{
		ref?: () => void;
		unref?: () => void;
	} | null>;
	if (active) {
		child.ref();
		for (const stream of streams) stream?.ref?.();
	} else {
		child.unref();
		for (const stream of streams) stream?.unref?.();
	}
}
