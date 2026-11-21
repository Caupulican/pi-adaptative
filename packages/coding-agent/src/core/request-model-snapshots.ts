import { isDeepStrictEqual } from "node:util";
import type { OAuthCredentials, OAuthProviderInterface } from "@caupulican/pi-ai/oauth";
import type { Api, Model } from "@caupulican/pi-ai/types";

/** One detached execution path for account-derived model changes, including caller-owned definitions. */
export function applyOAuthModelModifier(
	models: readonly Model<Api>[],
	credentials: OAuthCredentials,
	provider: Pick<OAuthProviderInterface, "modifyModels">,
): Model<Api>[] {
	const input = structuredClone([...models]);
	return structuredClone(provider.modifyModels ? provider.modifyModels(input, structuredClone(credentials)) : input);
}

type RequestModelOrigin = { kind: "registry" } | { kind: "caller"; baseline: Model<Api> };

/** Retains model ownership without retaining obsolete catalog generations or credential-derived caller state. */
export class RequestModelSnapshots {
	private readonly origins = new WeakMap<Model<Api>, RequestModelOrigin>();

	publishRegistry(models: readonly Model<Api>[]): void {
		for (const model of models) this.origins.set(model, { kind: "registry" });
	}

	bindAccountListing(
		selected: Model<Api>,
		effective: Model<Api>,
		catalog: readonly Model<Api>[],
		modifiesCaller: boolean,
		headersFor: (id: string) => Record<string, string> | undefined,
	): (target: Model<Api>) => boolean {
		let routes: Map<string, Model<Api> | undefined> | undefined;
		const registeredRoute = (id: string) => {
			if (id === selected.id && this.origins.get(selected)?.kind === "registry") return effective;
			if (!routes) {
				routes = new Map();
				for (const model of catalog) {
					if (model.provider === effective.provider)
						routes.set(model.id, routes.has(model.id) ? undefined : model);
				}
			}
			return routes.get(id);
		};
		const checkedHeaders = structuredClone(headersFor(effective.id));
		return (target) => {
			if (target.provider !== effective.provider || !isDeepStrictEqual(headersFor(target.id), checkedHeaders))
				return false;
			const origin = this.origins.get(target);
			const route =
				origin?.kind === "registry"
					? registeredRoute(target.id)
					: target === selected || target === effective
						? effective
						: modifiesCaller
							? undefined
							: (origin?.baseline ?? target);
			return (
				route !== undefined &&
				route.api === effective.api &&
				route.baseUrl === effective.baseUrl &&
				isDeepStrictEqual(route.headers, effective.headers)
			);
		};
	}

	resolve(
		selected: Model<Api>,
		catalog: readonly Model<Api>[],
		provider: Pick<OAuthProviderInterface, "modifyModels"> | undefined,
		credentials: OAuthCredentials | undefined,
	): Model<Api> {
		let origin = this.origins.get(selected);
		if (!origin) {
			// An untracked SDK definition is caller configuration, even when its ID matches the catalog.
			origin = { kind: "caller", baseline: structuredClone(selected) };
			this.origins.set(selected, origin);
		}
		const candidates =
			origin.kind === "registry"
				? catalog
				: provider && credentials
					? applyOAuthModelModifier([origin.baseline], credentials, provider)
					: [origin.baseline];
		const matches = candidates.filter((model) => model.provider === selected.provider && model.id === selected.id);
		if (matches.length !== 1) {
			throw new Error(`Model ${selected.provider}/${selected.id} is no longer uniquely available for this account`);
		}
		const snapshot = structuredClone(matches[0]);
		this.origins.set(snapshot, origin);
		return snapshot;
	}
}
