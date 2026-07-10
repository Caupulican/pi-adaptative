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
	/** Adapter identity for this request; set by RuntimeResidencyArbiter before planning. */
	adapterId?: string;
	/** When pinActiveModel is set, constrain that pin to this adapter when present. */
	pinActiveAdapterId?: string;
	reservations?: RuntimeReservation[];
	recentEvictions?: RuntimeEvictionRecord[];
	/** False performs admission/eviction only; the real model request owns cold loading. Default true. */
	loadModel?: boolean;
}

export interface RuntimeReservation {
	model: string;
	bytes: number;
	priority: number;
	/** Optional runtime identity; omitted means any adapter serving this model. */
	adapterId?: string;
}

export interface RuntimeEvictionRecord {
	evicted: string;
	loaded: string;
	atMs: number;
	/** Optional identities preserve anti-thrash separation across runtime adapters. */
	evictedAdapterId?: string;
	loadedAdapterId?: string;
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
		const requestForAdapter: RuntimeLoadRequest = {
			...request,
			adapterId,
			...(request.pinActiveModel !== undefined && request.pinActiveAdapterId === undefined
				? { pinActiveAdapterId: adapterId }
				: {}),
		};
		const plan = planRuntimeResidency({ budgetBytes: this.budgetBytes, residents, request: requestForAdapter });
		if (plan.status !== "fits") return plan;
		for (const resident of plan.evict) {
			await this.adapters.get(resident.adapterId)?.release(resident.model);
		}
		const alreadyResident = residents.some(
			(resident) => resident.adapterId === adapterId && resident.model === request.model,
		);
		if (request.loadModel !== false && !alreadyResident) await adapter.ensureResident(request.model);
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
	const requestedModels = new Map<string, { model: string; adapterId?: string; bytes: number; priority: number }>();
	const addRequestedModel = (entry: { model: string; adapterId?: string; bytes: number; priority: number }): void => {
		const key = `${entry.adapterId ?? "*"}\0${entry.model}`;
		const existing = requestedModels.get(key);
		if (!existing || entry.bytes > existing.bytes) requestedModels.set(key, entry);
	};
	addRequestedModel(args.request);
	for (const reservation of args.request.reservations ?? []) {
		addRequestedModel({
			...reservation,
			adapterId:
				reservation.adapterId ?? (reservation.model === args.request.model ? args.request.adapterId : undefined),
		});
	}

	const isResidentForRequest = (
		resident: RuntimeResidentModel,
		requested: { model: string; adapterId?: string },
	): boolean =>
		resident.model === requested.model &&
		(requested.adapterId === undefined || resident.adapterId === requested.adapterId);
	const residentBytes = args.residents.reduce((sum, resident) => sum + resident.bytes, 0);
	const missingBytes = [...requestedModels.values()].reduce((sum, requested) => {
		return args.residents.some((resident) => isResidentForRequest(resident, requested)) ? sum : sum + requested.bytes;
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
		.filter(
			(resident) => ![...requestedModels.values()].some((requested) => isResidentForRequest(resident, requested)),
		)
		.filter(
			(resident) =>
				!resident.pinned &&
				!(
					resident.model === args.request.pinActiveModel &&
					(args.request.pinActiveAdapterId === undefined || resident.adapterId === args.request.pinActiveAdapterId)
				),
		)
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
		(record) =>
			record.evicted === request.model &&
			(request.adapterId === undefined ||
				record.evictedAdapterId === undefined ||
				record.evictedAdapterId === request.adapterId) &&
			request.nowMs - record.atMs <= (request.minDwellMs ?? 0),
	);
}
