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
		// An accepted mutation may finish through its explicit candidate validator during close.
		if (!assertCurrent) this.closed.signal.throwIfAborted();
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

	admit(
		kind: string,
		label: string,
		signal?: AbortSignal,
		runtimeLease?: RuntimeWorkLease,
	): RuntimeWorkLease | Promise<RuntimeWorkLease> {
		const admissionSignal = signal ? AbortSignal.any([signal, this.closed.signal]) : this.closed.signal;
		admissionSignal.throwIfAborted();
		const immediate = runtimeLease ?? this.admission.tryAdmitWork({ kind, label });
		if (immediate) return this.validateAdmission(immediate, admissionSignal);
		return this.admission
			.admitWork({ kind, label, signal: admissionSignal, report: this.report })
			.then((reader) => this.validateAdmission(reader, admissionSignal));
	}

	private validateAdmission(reader: RuntimeWorkLease, signal: AbortSignal): RuntimeWorkLease {
		try {
			signal.throwIfAborted();
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
		assertCurrent?: () => void,
	): Promise<T> {
		const admitted = this.admit(kind, label, signal, borrowed);
		const reader = admitted instanceof Promise ? await admitted : admitted;
		try {
			assertCurrent?.();
			return await operation(reader);
		} finally {
			reader.release();
		}
	}
}
