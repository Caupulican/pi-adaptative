/** Samples session-derived Workbench views away from terminal paints. */

import { performance } from "node:perf_hooks";

// Coalesce bursts of session events and clock/animation requests into a single read.
const SAMPLE_INTERVAL_MS = 50;

interface WorkbenchProjectionSource<View> {
	requestedRevision(): number;
	compose(): View;
	publish(): void;
}

export class WorkbenchViewProjection<View> {
	private readonly source: WorkbenchProjectionSource<View>;
	private model: View | undefined;
	private revision: number | undefined;
	private nextSampleAt = 0;
	private scheduled: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;

	constructor(source: WorkbenchProjectionSource<View>) {
		this.source = source;
	}

	read(visible = true): View | undefined {
		if (!visible) {
			this.cancelSample();
			this.revision = undefined;
			return undefined;
		}
		if (this.revision !== this.source.requestedRevision() && this.scheduled === undefined) {
			this.scheduled = setTimeout(
				() => {
					this.scheduled = undefined;
					const revision = this.source.requestedRevision();
					const generation = this.generation;
					const model = this.source.compose();
					if (generation !== this.generation) return;
					this.model = model;
					this.revision = revision;
					this.nextSampleAt = performance.now() + SAMPLE_INTERVAL_MS;
					this.source.publish();
				},
				Math.max(0, this.nextSampleAt - performance.now()),
			);
		}
		return this.model;
	}

	reset(): void {
		this.cancelSample();
		this.generation++;
		this.model = undefined;
		this.revision = undefined;
		this.nextSampleAt = 0;
	}

	private cancelSample(): void {
		if (this.scheduled === undefined) return;
		clearTimeout(this.scheduled);
		this.scheduled = undefined;
	}
}
