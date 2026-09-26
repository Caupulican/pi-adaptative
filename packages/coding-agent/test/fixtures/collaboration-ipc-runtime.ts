import type {
	CollaborationAgent,
	CollaborationJob,
	CollaborationJobStore,
} from "../../src/core/collaboration/job-store.ts";
import { launchCollaborationTurnProcess } from "../../src/core/collaboration/turn-process.ts";

if (process.argv[2] === "--collaboration-worker") {
	// Keep a real IPC child alive until its parent exits. The deadline bounds a failed probe; it sits
	// far past the test's bound so a parent that waits for this child can never pass.
	const watchdog = setTimeout(() => process.exit(2), 60_000);
	process.once("disconnect", () => {
		clearTimeout(watchdog);
		process.exit(0);
	});
	process.send?.({ type: "ready", turnId: "turn" });
} else {
	const agent = { id: "one", turnId: "turn", status: "done" } as CollaborationAgent;
	const job = { id: "job", cwd: process.cwd(), agents: [agent] } as CollaborationJob;
	const store = {
		directory: process.cwd(),
		parentSessionId: "parent",
		load: () => job,
	} as unknown as CollaborationJobStore;
	await launchCollaborationTurnProcess(store, job, agent);
	console.log("admitted");
	// No process.exit(): admission must release both process and IPC references.
}
