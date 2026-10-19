import { controllerData } from '../../nodecraft/controller.ts';

import type { ControllerClient } from '../../nodecraft/controller.ts';

export type JitStatus = 'hot' | 'live' | 'ready' | 'ready_to_store' | 'stored' | 'storing' | 'waking';

// Shape of controller's GET /instance/shared/:share_id (controllers/instances/jit.js)
export interface SharedServer {
	name: string;
	module?: string;
	jit_status: JitStatus | null;
	jit_available: boolean;
	jit_share_locked?: boolean;
	jit_share_password_enabled?: boolean;
	jit_share_discord_url?: string | null;
	// when a hot or idle server next steps toward hibernation; null while players keep it live
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

export function getSharedServer(client: ControllerClient, shareId: string): Promise<SharedServer> {
	return controllerData<SharedServer>(client, `/v2/instance/shared/${shareId}`);
}

// rateKey scopes controller's password attempt limit to one Discord user rather than Cloudflare's egress IPs
export function startSharedServer(client: ControllerClient, shareId: string, password: string | undefined, rateKey: string): Promise<unknown> {
	return controllerData<unknown>(client, `/v2/instance/shared/${shareId}/start`, {
		method: 'POST',
		body: JSON.stringify({ password: password ?? '' }),
		headers: { 'x-nc-rate-key': rateKey },
	});
}
