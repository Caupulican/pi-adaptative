import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { agentMemoryDir, knowledgeDatabaseFile } from "../src/core/agent-paths.ts";
import { readScopeRefusal, sessionReadScope } from "../src/core/autonomy/session-read-scope.ts";
import { workerMemoryScopeRefusal } from "../src/core/delegation/worker-execution-policy.ts";
import { delegateStartRejection } from "../src/core/tools/delegate-rejections.ts";

it("keeps raw knowledge private and refuses a workspace or explicit write grant reaching it", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-scope-"));
	try {
		const agentDir = join(root, "agent");
		const memory = agentMemoryDir(agentDir);
		const project = join(root, "project");
		mkdirSync(memory, { recursive: true });
		mkdirSync(project);
		const alias = join(project, "linked-memory");
		symlinkSync(memory, alias, "junction");
		const database = knowledgeDatabaseFile(agentDir);
		const scope = sessionReadScope({ cwd: project, agentDir });
		const refusal = (cwd: string, writePaths: string[]) => workerMemoryScopeRefusal(agentDir, { cwd, writePaths });
		for (const path of [
			database,
			`${database}-wal`,
			`${database}-shm`,
			`${database}-journal`,
			join(alias, "backup"),
		]) {
			expect(readScopeRefusal(scope, path)).toBe("denied");
			expect(refusal(project, [path])).toBe("worker_private_memory_scope");
		}
		expect(refusal(alias, [])).toBe("worker_private_memory_scope");
		expect(refusal(project, [agentDir])).toBe("worker_private_memory_scope");
		expect(refusal(root, [])).toBeUndefined();
		expect(refusal(project, [join(project, "memory")])).toBeUndefined();
		if (process.platform !== "win32") {
			const relocated = join(root, "relocated.sqlite");
			symlinkSync(relocated, database);
			const linkedScope = sessionReadScope({ cwd: project, agentDir });
			for (const file of [relocated, `${relocated}-wal`]) {
				expect(readScopeRefusal(linkedScope, file)).toBe("denied");
				expect(refusal(project, [file])).toBe("worker_private_memory_scope");
			}
		}
		expect(delegateStartRejection("worker_private_memory_scope").m).toContain("/taste accept");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
