import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticComponent implements Component {
	render(): string[] {
		return ["content"];
	}
	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const originalDebugRedraw = process.env.PI_DEBUG_REDRAW;
const originalTuiWorkDir = process.env.PI_TUI_WORK_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	for (const [name, value] of [
		["PI_DEBUG_REDRAW", originalDebugRedraw],
		["PI_TUI_WORK_DIR", originalTuiWorkDir],
		["PI_CODING_AGENT_DIR", originalAgentDir],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("TUI lifecycle", () => {
	it("clears the software cursor cell before restoring the terminal cursor", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.addChild(new StaticComponent());
		tui.start();
		await terminal.waitForRender();
		terminal.writes.length = 0;

		tui.stop();

		assert.equal(terminal.writes[0], " ");
	});

	it("keeps redraw logs inside the configured process work directory", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "pi-tui-lifecycle-"));
		try {
			process.env.PI_DEBUG_REDRAW = "1";
			process.env.PI_TUI_WORK_DIR = workDir;
			process.env.PI_CODING_AGENT_DIR = join(workDir, "wrong-agent-dir");
			const terminal = new VirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			tui.addChild(new StaticComponent());
			tui.start();
			await terminal.waitForRender();
			tui.stop();

			assert.match(readFileSync(join(workDir, "pi-debug.log"), "utf8"), /fullRender: first render/);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});
});
