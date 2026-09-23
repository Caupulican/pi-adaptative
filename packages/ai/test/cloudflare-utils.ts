import { liveTestsEnabled } from "./oauth.ts";

export function hasCloudflareWorkersAICredentials(): boolean {
	if (!liveTestsEnabled()) return false;
	return !!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID;
}

export function hasCloudflareAiGatewayCredentials(): boolean {
	if (!liveTestsEnabled()) return false;
	return (
		!!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_GATEWAY_ID
	);
}
