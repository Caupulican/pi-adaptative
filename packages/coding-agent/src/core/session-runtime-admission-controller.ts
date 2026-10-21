/**
 * Adapts session lifetime and resource mutation to the shared runtime generation admission owner.
 * It owns session cancellation and scoped release; generation authority remains in RuntimeGenerationAdmission.
 */
import {
	type RuntimeGenerationAdmission,
	RuntimeGenerationAdmissionError,
	type RuntimeWorkLease,
} from "./runtime-generation-admission.ts";
import type { WaitStatusEvent } from "./util/wait.ts";

export class SessionRuntimeAdmissionController {
	private readonly admission: RuntimeGenerationAdmission;
	private readonly report: (event: WaitStatusEvent) => void;
	private readonly closed = new AbortController();

	constructor(admission: RuntimeGenerationAdmission, report: (event: WaitStatusEvent) => void) {
		this.admission = admission;
		this.report = report;
	}

	close(): void {
		this.closed.abort(new Error("Session disposed before runtime work was admitted"));
	}

	mutateResources<T>(label: string, operation: () => T, assertCurrent?: () => void): T {
		const reader = assertCurrent ? undefined : this.admission.tryAdmitWork({ kind: "resource", label });
		if (!assertCurrent && !reader)
			throw new RuntimeGenerationAdmissionError(`Cannot change ${label} during runtime generation replacement.`);
		try {
			if (assertCurrent) assertCurrent();
			else reader!.assertCurrent();
			return operation();
		} finally {
			reader?.release();
		}
	}

	async admit(
		kind: string,
		label: string,
		signal?: AbortSignal,
		runtimeLease?: RuntimeWorkLease,
	): Promise<RuntimeWorkLease> {
		const admissionSignal = signal ? AbortSignal.any([signal, this.closed.signal]) : this.closed.signal;
		admissionSignal.throwIfAborted();
		const reader =
			runtimeLease ??
			(await this.admission.admitWork({
				kind,
				label,
				signal: admissionSignal,
				report: this.report,
			}));
		try {
			admissionSignal.throwIfAborted();
			this.admission.assertOwnWorkCurrent(reader);
			return reader;
		} catch (error) {
			reader.release();
			throw error;
		}
	}

	async run<T>(
		kind: string,
		label: string,
		operation: (reader: RuntimeWorkLease) => Promise<T>,
		signal?: AbortSignal,
		borrowed?: RuntimeWorkLease,
	): Promise<T> {
		const reader = await this.admit(kind, label, signal, borrowed);
		try {
			return await operation(reader);
		} finally {
			reader.release();
		}
	}
}
