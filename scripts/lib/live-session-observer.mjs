/** Passive native-UI acceptance observer. It reads the extension port and never submits owner input. */
import { writeFileSync, renameSync } from "node:fs";

export default function observeLiveSession(pi) {
	const file = process.env.PI_LIVE_OBSERVER_FILE;
	if (!file) return;
	let context;
	let timer;
	let sequence = 0;
	let lastAgentEnd;
	const inputs = [];
	const errors = [];
	const snapshot = () => {
		if (!context) return;
		try {
			const body = {
				pid: process.pid,
				sequence: ++sequence,
				observedAt: Date.now(),
				sessionId: context.sessionManager.getSessionId(),
				sessionFile: context.sessionManager.getSessionFile(),
				leafId: context.sessionManager.getLeafId(),
				idle: context.isIdle(),
				pending: context.hasPendingMessages(),
				editor: context.ui.getEditorText(),
				lastAgentEnd,
				inputs,
				errors,
			};
			writeFileSync(`${file}.tmp`, `${JSON.stringify(body)}\n`, { mode: 0o600 });
			renameSync(`${file}.tmp`, file);
		} catch (error) {
			errors.push(String(error));
			if (errors.length > 8) errors.shift();
		}
	};
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		lastAgentEnd = undefined;
		clearInterval(timer);
		// Poll outside event handlers: waiting inside agent_end would hold the lifecycle being observed.
		timer = setInterval(snapshot, 250);
		timer.unref();
		snapshot();
	});
	pi.on("input", (event, ctx) => {
		context = ctx;
		inputs.push({ at: Date.now(), sessionId: ctx.sessionManager.getSessionId(), text: event.text });
		if (inputs.length > 64) inputs.shift();
		snapshot();
		return { action: "continue" };
	});
	pi.on("agent_end", (event, ctx) => {
		context = ctx;
		lastAgentEnd = { at: Date.now(), sessionId: ctx.sessionManager.getSessionId(), willRetry: event.willRetry };
		snapshot();
	});
	pi.on("session_shutdown", () => {
		snapshot();
		clearInterval(timer);
	});
}
