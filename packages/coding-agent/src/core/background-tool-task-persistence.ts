/** Owns background-tool record projection and scheduling on the session's durable mutation queue. */
import type {
	BackgroundToolTaskControllerDeps,
	BackgroundToolTaskPersistenceKind,
	BackgroundToolTaskRecord,
} from "./background-tool-task-controller.ts";

export class BackgroundToolTaskPersistence {
	private readonly port: Pick<
		BackgroundToolTaskControllerDeps,
		"persist" | "queueMutation" | "getSessionId" | "getSessionLineageIds"
	>;
	private readonly report: (message: string, error: unknown) => void;
	private readonly onFailure: (error: unknown) => void;

	constructor(
		port: BackgroundToolTaskPersistence["port"],
		report: BackgroundToolTaskPersistence["report"],
		onFailure: BackgroundToolTaskPersistence["onFailure"],
	) {
		this.port = port;
		this.report = report;
		this.onFailure = onFailure;
	}

	lineageSessionIds(): Set<string> {
		const sessionId = this.port.getSessionId();
		const lineage = new Set(this.port.getSessionLineageIds?.());
		lineage.add(sessionId);
		return lineage;
	}

	run(commit: () => void): Promise<void> | void {
		return this.port.queueMutation ? this.port.queueMutation(commit) : commit();
	}

	enqueue(taskId: string, commit: () => void): void {
		const fail = (error: unknown): void => {
			this.onFailure(error);
			this.report(`Failed to update background tool task ${taskId}`, error);
		};
		try {
			void this.run(commit)?.catch(fail);
		} catch (error) {
			fail(error);
		}
	}

	write(record: BackgroundToolTaskRecord, kind: BackgroundToolTaskPersistenceKind = "snapshot"): boolean {
		try {
			const durableRecord = { ...record };
			delete durableRecord.observedAt;
			delete durableRecord.ownerEpoch;
			this.port.persist(durableRecord, kind);
			return true;
		} catch (error) {
			this.report(`Failed to persist background tool task ${record.taskId}`, error);
			return false;
		}
	}
}
