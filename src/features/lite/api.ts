import { controllerData } from '../../nodecraft/controller.ts';

import type { ControllerClient } from '../../nodecraft/controller.ts';

export type JitStatus = 'hot' | 'live' | 'ready' | 'ready_to_store' | 'stored' | 'storing' | 'waking';
// Lite servers hibernate and wake; Pro servers are deployed or archived, and only their owner can redeploy them
export type ShareType = 'lite' | 'pro';

// Shape of controller's GET /instance/shared/:share_id (controllers/instances/share.js), with legacy field names folded in
export interface SharedServer {
	name: string;
	module?: string;
	share_type: ShareType;
	share_locked?: boolean | null;
	share_password_enabled?: boolean | null;
	share_discord_url?: string | null;
	// Lite only
	jit_status?: JitStatus | null;
	// false for an archived Pro server, or a Lite server whose plan is running another server
	jit_available: boolean;
	// Lite only: when a hot or idle server next steps toward hibernation; null while players keep it live
	jit_expires_date?: string | null;
	// only present for running servers (rules engine flag)
	join_article?: string;
	network?: {
		address?: string;
		hostname?: string;
		domain?: string;
	};
	default_port?: number | null;
	status?: string;
	// online player count; controller never returns names on this public route
	players?: number;
}

type SharedServerResponse = Omit<SharedServer, 'share_type'> & {
	share_type?: ShareType;
	jit_share_locked?: boolean | null;
	jit_share_password_enabled?: boolean | null;
	jit_share_discord_url?: string | null;
};

// controller deploys from before Pro share links only send the jit_share_* names and no share_type
export function parseSharedServer(data: SharedServerResponse): SharedServer {
	const {
		jit_share_locked,
		jit_share_password_enabled,
		jit_share_discord_url,
		...server
	} = data;
	return {
		...server,
		share_type: data.share_type ?? 'lite',
		share_locked: data.share_locked ?? jit_share_locked,
		share_password_enabled: data.share_password_enabled ?? jit_share_password_enabled,
		share_discord_url: data.share_discord_url ?? jit_share_discord_url,
	};
}

export async function getSharedServer(client: ControllerClient, shareId: string): Promise<SharedServer> {
	return parseSharedServer(await controllerData<SharedServerResponse>(client, `/v2/instance/shared/${shareId}`));
}

// rateKey scopes controller's password attempt limit to one Discord user rather than Cloudflare's egress IPs
export function startSharedServer(client: ControllerClient, shareId: string, password: string | undefined, rateKey: string): Promise<unknown> {
	return controllerData<unknown>(client, `/v2/instance/shared/${shareId}/start`, {
		method: 'POST',
		body: JSON.stringify({ password: password ?? '' }),
		headers: { 'x-nc-rate-key': rateKey },
	});
}
