import { ChildProcess } from "node:child_process";
import { WorkspaceObservation } from "../../src/modes/interactive/workbench-workspace.ts";

// Defence in depth: the parent launches a detached fixture, and this fence prevents a regression
// from ever reaching libuv with the unspawned handle whose internal PID can mean the whole group.
let invalidKills = 0;
let receivedSignals = 0;
const originalKill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function (signal) {
	if (!Number.isSafeInteger(this.pid) || this.pid <= 0) {
		invalidKills++;
		return false;
	}
	return originalKill.call(this, signal);
};
process.on("SIGTERM", () => receivedSignals++);
const [failure, timing, directory] = process.argv.slice(2);
if (failure === "missing-command") process.env.PATH = directory;
const cwd = failure === "missing-cwd" ? `${directory}/absent` : directory;
const observer = new WorkspaceObservation();
const pending = [];
for (let attempt = 0; attempt < 4; attempt++) {
	pending.push(observer.begin(cwd));
	if (timing === "settled") await pending.at(-1);
	if (timing === "dispose") observer.dispose();
}
await Promise.all(pending);
observer.dispose();
await new Promise((resolve) => setImmediate(resolve));
console.log(JSON.stringify({ invalidKills, receivedSignals, settled: true }));
