/** Tunable constants of one damped harmonic oscillator (unit mass). */
export interface SpringConfig {
	/** Spring constant k, > 0. */
	readonly stiffness: number;
	/** Damping coefficient c, >= 0. */
	readonly damping: number;
	/** A spring is settled when |value - target| and |velocity| are both below this. */
	readonly precision: number;
}

/** Critically damped, settles in about 250 ms. */
export const SPRING_SNAPPY: SpringConfig = { stiffness: 900, damping: 2 * Math.sqrt(900), precision: 0.01 };

/** Critically damped, settles in about 600 ms. */
export const SPRING_SOFT: SpringConfig = { stiffness: 160, damping: 2 * Math.sqrt(160), precision: 0.01 };

/** Position, velocity and rest position of one spring. */
export interface SpringState {
	readonly value: number;
	readonly velocity: number;
	readonly target: number;
}

const SUBSTEPS_PER_SECOND = 240;
const SUBSTEP_SECONDS = 1 / SUBSTEPS_PER_SECOND;
const MAX_STEP_SECONDS = 0.1;

function assertConfig(config: SpringConfig): void {
	if (!(config.stiffness > 0) || !Number.isFinite(config.stiffness)) {
		throw new Error(`Spring stiffness must be a finite number > 0, got ${config.stiffness}`);
	}
	if (!(config.damping >= 0) || !Number.isFinite(config.damping)) {
		throw new Error(`Spring damping must be a finite number >= 0, got ${config.damping}`);
	}
	if (!(config.precision > 0) || !Number.isFinite(config.precision)) {
		throw new Error(`Spring precision must be a finite number > 0, got ${config.precision}`);
	}
}

function assertFinite(name: string, value: number): void {
	if (!Number.isFinite(value)) throw new Error(`Spring ${name} must be finite, got ${value}`);
}

/** True when the spring is within `config.precision` of rest on both position and velocity. */
export function isSettled(state: SpringState, config: SpringConfig): boolean {
	return Math.abs(state.value - state.target) < config.precision && Math.abs(state.velocity) < config.precision;
}

/**
 * Advances one spring by `dtSeconds` with semi-implicit Euler in fixed 1/240 s substeps, so the
 * trajectory does not depend on the frame rate. `dtSeconds` is clamped to [0, 0.1]; a settled
 * result snaps exactly onto the target.
 */
export function stepSpring(state: SpringState, dtSeconds: number, config: SpringConfig): SpringState {
	if (!Number.isFinite(dtSeconds) || dtSeconds < 0) {
		throw new Error(`Spring step must be a finite, non-negative number of seconds, got ${dtSeconds}`);
	}
	assertConfig(config);
	const dt = Math.min(dtSeconds, MAX_STEP_SECONDS);
	if (dt === 0) return state;
	const { target } = state;
	let { value, velocity } = state;
	const whole = Math.floor(dt * SUBSTEPS_PER_SECOND);
	const partial = dt - whole * SUBSTEP_SECONDS;
	for (let i = 0; i <= whole; i++) {
		const h = i < whole ? SUBSTEP_SECONDS : partial;
		if (h <= 0) continue;
		velocity += (-config.stiffness * (value - target) - config.damping * velocity) * h;
		value += velocity * h;
	}
	const next: SpringState = { value, velocity, target };
	return isSettled(next, config) ? { value: target, velocity: 0, target } : next;
}

interface SpringEntry {
	readonly state: SpringState;
	readonly config: SpringConfig;
}

/** Named table of springs; the host steps it with a clock and every frame reads from it. */
export class SpringTable {
	private readonly defaultConfig: SpringConfig;
	private readonly entries = new Map<string, SpringEntry>();
	private lastStepMs: number | undefined;

	constructor(config: SpringConfig = SPRING_SNAPPY) {
		assertConfig(config);
		this.defaultConfig = config;
	}

	get size(): number {
		return this.entries.size;
	}

	/** Creates the spring at `target` when new; otherwise retargets, keeping value and velocity. */
	set(id: string, target: number, options?: { readonly jump?: boolean; readonly config?: SpringConfig }): void {
		assertFinite("target", target);
		if (options?.config) assertConfig(options.config);
		const existing = this.entries.get(id);
		const config = options?.config ?? existing?.config ?? this.defaultConfig;
		if (!existing || options?.jump) {
			this.entries.set(id, { state: { value: target, velocity: 0, target }, config });
			return;
		}
		this.entries.set(id, { state: { ...existing.state, target }, config });
	}

	/** Advances every spring by the time since the previous call; the first call only records the clock. */
	step(nowMs: number): void {
		assertFinite("clock", nowMs);
		const last = this.lastStepMs;
		this.lastStepMs = nowMs;
		if (last === undefined) return;
		if (nowMs < last) throw new Error(`Spring clock went backwards: ${last} -> ${nowMs}`);
		const dtSeconds = Math.min((nowMs - last) / 1000, MAX_STEP_SECONDS);
		if (dtSeconds === 0) return;
		for (const [id, entry] of this.entries) {
			this.entries.set(id, { state: stepSpring(entry.state, dtSeconds, entry.config), config: entry.config });
		}
	}

	value(id: string): number | undefined {
		return this.entries.get(id)?.state.value;
	}

	state(id: string): SpringState | undefined {
		return this.entries.get(id)?.state;
	}

	/** True when every spring is settled; an empty table is settled. */
	settled(): boolean {
		for (const entry of this.entries.values()) {
			if (!isSettled(entry.state, entry.config)) return false;
		}
		return true;
	}

	delete(id: string): void {
		this.entries.delete(id);
	}

	clear(): void {
		this.entries.clear();
	}
}
