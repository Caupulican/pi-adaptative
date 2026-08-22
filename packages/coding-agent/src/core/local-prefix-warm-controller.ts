/** Best-effort, preemptible standing-prefix warmup for loopback OpenAI-compatible models. */

import { projectToolsForProvider } from "@caupulican/pi-agent-core/provider-tool-projection";
import type { AgentTool, StreamFn } from "@caupulican/pi-agent-core/types";
import type { Api, Model, SimpleStreamOptions } from "@caupulican/pi-ai";
import { formatModelRouterModel } from "./model-router-controller.ts";
import { HF_TRANSFORMERS_PROVIDER, OLLAMA_PROVIDER } from "./models/local-registration.ts";
import { isLoopbackModelEndpoint } from "./models/model-endpoint.ts";
import type { RequestAuth } from "./request-auth.ts";

export interface LocalPrefixWarmControllerDeps {
	getStreamFn(): StreamFn;
	getTools(): AgentTool[];
	getSystemPrompt(): string;
	getRequestHooks(): Pick<SimpleStreamOptions, "onPayload" | "onResponse">;
	isRawStreamSimple(streamFn: StreamFn): boolean;
	getRequiredRequestAuth(model: Model<Api>): Promise<RequestAuth>;
	ensureManagedModelReady(model: Model<Api>): Promise<void>;
}

export function isWarmableLocalModel(model: Model<Api>): boolean {
	return model.api === "openai-completions" && isLoopbackModelEndpoint(model.baseUrl);
}

export class LocalPrefixWarmController {
	private readonly deps: LocalPrefixWarmControllerDeps;
	private active: { modelKey: string; controller: AbortController; timer: NodeJS.Timeout | undefined } | undefined;
	private readonly completed = new Set<string>();

	constructor(deps: LocalPrefixWarmControllerDeps) {
		this.deps = deps;
	}

	schedule(model: Model<Api> | undefined): void {
		if (!model || !isWarmableLocalModel(model)) return;
		const modelKey = formatModelRouterModel(model);
		if (this.completed.has(modelKey) || this.active?.modelKey === modelKey) return;
		this.cancel();
		const controller = new AbortController();
		const timer = setTimeout(() => {
			const active = this.active;
			if (!active || active.controller !== controller || controller.signal.aborted) return;
			active.timer = undefined;
			void this.run(model, modelKey, controller);
		}, 0);
		timer.unref?.();
		this.active = { modelKey, controller, timer };
	}

	cancel(): void {
		const active = this.active;
		if (!active) return;
		if (active.timer) clearTimeout(active.timer);
		active.controller.abort(new Error("prefix warmer preempted"));
		this.active = undefined;
	}

	private async run(model: Model<Api>, modelKey: string, controller: AbortController): Promise<void> {
		try {
			const streamFn = this.deps.getStreamFn();
			const options: SimpleStreamOptions = {
				maxTokens: 1,
				signal: controller.signal,
				...this.deps.getRequestHooks(),
			};
			if (this.deps.isRawStreamSimple(streamFn)) {
				const auth = await this.deps.getRequiredRequestAuth(model);
				options.apiKey = auth.apiKey;
				options.headers = auth.headers;
			}
			if (controller.signal.aborted) return;
			if (model.provider === OLLAMA_PROVIDER || model.provider === HF_TRANSFORMERS_PROVIDER) {
				await this.deps.ensureManagedModelReady(model);
			}
			if (controller.signal.aborted) return;
			const stream = await streamFn(
				model,
				{
					systemPrompt: this.deps.getSystemPrompt(),
					tools: projectToolsForProvider(this.deps.getTools()),
					messages: [],
				},
				options,
			);
			await stream.result();
			if (!controller.signal.aborted) this.completed.add(modelKey);
		} catch {
			// A cache miss must never affect the real turn.
		} finally {
			if (this.active?.controller === controller) this.active = undefined;
		}
	}
}
