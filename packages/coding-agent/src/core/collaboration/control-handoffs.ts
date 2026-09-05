import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { CollaborationJobStore } from "./job-store.ts";

const noticeSchema = Type.Object(
	{
		source: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
		turnId: Type.String({ maxLength: 128 }),
		error: Type.String({ maxLength: 512 }),
		delivered: Type.Boolean(),
	},
	{ additionalProperties: false },
);
type StoredNotice = Static<typeof noticeSchema>;
export type CollaborationControlNotice = Omit<StoredNotice, "delivered"> & { jobId: string };

/** Control failure is not worker completion. Receipts only acknowledge parent outbox admission. */
export class CollaborationControlHandoffs {
	private readonly store: CollaborationJobStore;
	private readonly notify: (notice: CollaborationControlNotice) => void;
	constructor(store: CollaborationJobStore, notify: CollaborationControlHandoffs["notify"]) {
		this.store = store;
		this.notify = notify;
	}
	record(jobId: string, source: string, turnId: string, error: string): void {
		const notice = { source, turnId, error: error.slice(0, 512), delivered: false };
		if (!Value.Check(noticeSchema, notice)) throw new Error("Invalid collaboration control failure identity.");
		this.store.update(jobId, (job) => {
			const key = `control:${source}`;
			const previous: unknown = job.metadata[key] ? JSON.parse(job.metadata[key]) : undefined;
			if (Value.Check(noticeSchema, previous) && previous.turnId === turnId) return;
			job.metadata[key] = JSON.stringify(notice);
		});
	}
	clear(jobId: string, source: string): void {
		if (!Value.Check(noticeSchema.properties.source, source))
			throw new Error("Invalid collaboration control failure source.");
		this.store.update(jobId, (job) => {
			delete job.metadata[`control:${source}`];
		});
	}
	flush(): void {
		for (const job of this.store.list())
			for (const [key, encoded] of Object.entries(job.metadata)) {
				if (!key.startsWith("control:")) continue;
				const notice: unknown = JSON.parse(encoded);
				if (!Value.Check(noticeSchema, notice)) throw new Error("Invalid persisted collaboration control handoff.");
				if (notice.delivered) continue;
				this.notify({ jobId: job.id, source: notice.source, turnId: notice.turnId, error: notice.error });
				this.store.update(job.id, (current) => {
					if (current.metadata[key] === encoded)
						current.metadata[key] = JSON.stringify({ ...notice, delivered: true });
				});
			}
	}
}
