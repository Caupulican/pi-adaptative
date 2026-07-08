import type { OllamaRuntime, TransformersRuntime } from "./local-runtime.ts";

export type ResidencyControl = "full" | "keep-alive" | "advisory";
export type RuntimeRole = "active" | "router" | "bench" | "probe";

export interface RuntimeResidentModel {
	adapterId: string;
	model: string;
	bytes: number;
	lastUsedAtMs: number;
	priority: number;
	pinned?: boolean;
	residencyControl: ResidencyControl;
}

export interface RuntimeLoadRequest {
	model: string;
	bytes: number;
	role: RuntimeRole;
	priority: number;
	nowMs: number;
	minDwellMs?: number;
	pinActiveModel?: string;
	reservations?: RuntimeReservation[];
	recentEvictions?: RuntimeEvictionRecord[];
}

export interface RuntimeReservation {
	model: string;
	bytes: number;
	priority: number;
}

export interface RuntimeEvictionRecord {
	evicted: string;
	loaded: string;
	atMs: number;
}

export type RuntimeResidencyPlan =
	| { status: "fits"; evict: RuntimeResidentModel[]; requiredBytes: number; budgetBytes: number }
	| { status: "refuse"; reason: string; evict: RuntimeResidentModel[]; requiredBytes: number; budgetBytes: number };

export interface RuntimeResidencyAdapter {
	id: string;
	residencyControl: ResidencyControl;
	list(): Promise<RuntimeResidentModel[]>;
	ensureResident(model: string): Promise<void>;
	release(model: string): Promise<void>;
}

export class RuntimeResidencyArbiter {
	private readonly budgetBytes: number;
	private readonly adapters: Map<string, RuntimeResidencyAdapter>;

	constructor(args: { budgetBytes: number; adapters: RuntimeResidencyAdapter[] }) {
		this.budgetBytes = args.budgetBytes;
		this.adapters = new Map(args.adapters.map((adapter) => [adapter.id, adapter]));
	}

	async ensureResident(adapterId: string, request: RuntimeLoadRequest): Promise<RuntimeResidencyPlan> {
		const adapter = this.adapters.get(adapterId);
		const residents = (await Promise.all([...this.adapters.values()].map((entry) => entry.list()))).flat();
		if (!adapter) {
			return {
				status: "refuse",
				reason: "unknown-adapter",
				evict: [],
				requiredBytes: request.bytes,
				budgetBytes: this.budgetBytes,
			};
		}
		const plan = planRuntimeResidency({ budgetBytes: this.budgetBytes, residents, request });
		if (plan.status !== "fits") return plan;
		for (const resident of plan.evict) {
			await this.adapters.get(resident.adapterId)?.release(resident.model);
		}
		await adapter.ensureResident(request.model);
		return plan;
	}
}

export class OllamaRuntimeResidencyAdapter implements RuntimeResidencyAdapter {
	readonly id: string;
	readonly residencyControl = "keep-alive" as const;
	private readonly runtime: Pick<OllamaRuntime, "listResidentModels" | "ensureResident" | "releaseResident">;
	private readonly nowMs: () => number;

	constructor(
		id: string,
		runtime: Pick<OllamaRuntime, "listResidentModels" | "ensureResident" | "releaseResident">,
		options: { nowMs?: () => number } = {},
	) {
		this.id = id;
		this.runtime = runtime;
		this.nowMs = options.nowMs ?? Date.now;
	}

	async list(): Promise<RuntimeResidentModel[]> {
		const now = this.nowMs();
		return (await this.runtime.listResidentModels()).map((model) => ({
			adapterId: this.id,
			model: model.name,
			bytes: model.sizeBytes,
			lastUsedAtMs: now,
			priority: 10,
			residencyControl: this.residencyControl,
		}));
	}

	async ensureResident(model: string): Promise<void> {
		const result = await this.runtime.ensureResident(model);
		if (!result.ok) throw new Error(result.error);
	}

	async release(model: string): Promise<void> {
		await this.runtime.releaseResident(model);
	}
}

export class TransformersRuntimeResidencyAdapter implements RuntimeResidencyAdapter {
	readonly id: string;
	readonly residencyControl = "full" as const;
	private readonly runtime: Pick<TransformersRuntime, "detect" | "start" | "stop">;
	private readonly model: string;
	private readonly bytes: number;
	private readonly nowMs: () => number;

	constructor(
		id: string,
		runtime: Pick<TransformersRuntime, "detect" | "start" | "stop">,
		model: string,
		bytes: number,
		options: { nowMs?: () => number } = {},
	) {
		this.id = id;
		this.runtime = runtime;
		this.model = model;
		this.bytes = bytes;
		this.nowMs = options.nowMs ?? Date.now;
	}

	async list(): Promise<RuntimeResidentModel[]> {
		const status = await this.runtime.detect();
		if (!status.serverUp) return [];
		return [
			{
				adapterId: this.id,
				model: this.model,
				bytes: this.bytes,
				lastUsedAtMs: this.nowMs(),
				priority: 10,
				residencyControl: this.residencyControl,
			},
		];
	}

	async ensureResident(_model: string): Promise<void> {
		const result = await this.runtime.start();
		if (!result.started && result.reason !== "already_running") throw new Error(result.reason);
	}

	async release(_model: string): Promise<void> {
		this.runtime.stop();
	}
}

export class AdvisoryRuntimeResidencyAdapter implements RuntimeResidencyAdapter {
	readonly id: string;
	readonly residencyControl = "advisory" as const;
	private readonly residents: RuntimeResidentModel[];

	constructor(id: string, residents: Omit<RuntimeResidentModel, "adapterId" | "residencyControl">[]) {
		this.id = id;
		this.residents = residents.map((resident) => ({
			...resident,
			adapterId: id,
			residencyControl: this.residencyControl,
		}));
	}

	async list(): Promise<RuntimeResidentModel[]> {
		return [...this.residents];
	}

	async ensureResident(_model: string): Promise<void> {}

	async release(_model: string): Promise<void> {}
}

export function planRuntimeResidency(args: {
	budgetBytes: number;
	residents: readonly RuntimeResidentModel[];
	request: RuntimeLoadRequest;
}): RuntimeResidencyPlan {
	const requestedModels = new Map<string, { bytes: number; priority: number }>();
	requestedModels.set(args.request.model, { bytes: args.request.bytes, priority: args.request.priority });
	for (const reservation of args.request.reservations ?? []) {
		const existing = requestedModels.get(reservation.model);
		if (!existing || reservation.bytes > existing.bytes) {
			requestedModels.set(reservation.model, { bytes: reservation.bytes, priority: reservation.priority });
		}
	}

	const residentByModel = new Map(args.residents.map((resident) => [resident.model, resident]));
	const residentBytes = args.residents.reduce((sum, resident) => sum + resident.bytes, 0);
	const missingBytes = [...requestedModels].reduce((sum, [model, request]) => {
		return residentByModel.has(model) ? sum : sum + request.bytes;
	}, 0);
	const requiredBytes = residentBytes + missingBytes;
	if (requiredBytes <= args.budgetBytes) {
		return { status: "fits", evict: [], requiredBytes, budgetBytes: args.budgetBytes };
	}

	if (hasPingPongRisk(args.request)) {
		return { status: "refuse", reason: "anti-thrash", evict: [], requiredBytes, budgetBytes: args.budgetBytes };
	}

	let projectedBytes = requiredBytes;
	const evict: RuntimeResidentModel[] = [];
	const candidates = args.residents
		.filter((resident) => !requestedModels.has(resident.model))
		.filter((resident) => !resident.pinned && resident.model !== args.request.pinActiveModel)
		.filter((resident) => resident.residencyControl !== "advisory")
		.filter(
			(resident) =>
				args.request.minDwellMs === undefined ||
				args.request.nowMs - resident.lastUsedAtMs >= args.request.minDwellMs,
		)
		.sort((left, right) => left.priority - right.priority || left.lastUsedAtMs - right.lastUsedAtMs);
	for (const candidate of candidates) {
		evict.push(candidate);
		projectedBytes -= candidate.bytes;
		if (projectedBytes <= args.budgetBytes) {
			return { status: "fits", evict, requiredBytes, budgetBytes: args.budgetBytes };
		}
	}
	return {
		status: "refuse",
		reason: "insufficient-evictable-memory",
		evict,
		requiredBytes,
		budgetBytes: args.budgetBytes,
	};
}

function hasPingPongRisk(request: RuntimeLoadRequest): boolean {
	return (request.recentEvictions ?? []).some(
		(record) => record.evicted === request.model && request.nowMs - record.atMs <= (request.minDwellMs ?? 0),
	);
}
