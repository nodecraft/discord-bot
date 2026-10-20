import { nc_fetch_oauth } from '@nodecraft/workers-helpers';

import { withTimeout } from '../lib/timeout.ts';

import type { Env } from '../env.ts';

// covers nc_fetch's own retries too, which otherwise retry a temporarily unavailable controller with no limit
const REQUEST_TIMEOUT_MS = 15000;

// keyed by client so environments sharing a namespace never pick up each other's tokens
function oauthKey(env: Env): string {
	return `oauth:${env.NODECRAFT_CLIENT_ID}`;
}

interface StoredTokens {
	access: string;
	accessExpires: string;
	scope?: string;
}

export type ControllerClient = nc_fetch_oauth;

// Follows billing's controller client: one instance per request, tokens shared through KV rather than module state
export async function controller(env: Env, waitUntil?: (promise: Promise<unknown>) => void): Promise<ControllerClient> {
	const client = new nc_fetch_oauth({
		useragent: 'NodecraftDiscordBot/1.0.0',
		baseurl: env.NODECRAFT_API_URL,
		token_url: `${env.NODECRAFT_API_URL}/oauth/token`,
		client_id: env.NODECRAFT_CLIENT_ID,
		client_secret: env.NODECRAFT_CLIENT_SECRET,
		scope: env.NODECRAFT_OAUTH_SCOPE,
		grant_type: 'client_credentials',
		expireBuffer: 900000, // 15 minutes
		refreshedHook: async (data: StoredTokens) => {
			const promise = env.DISCORD_BOT_SETTINGS.put(oauthKey(env), JSON.stringify(data));
			if (waitUntil) {
				waitUntil(promise);
			} else {
				await promise;
			}
		},
	});
	const stored = await env.DISCORD_BOT_SETTINGS.get<StoredTokens>(oauthKey(env), 'json');
	if (stored) {
		client.set(stored);
	}
	// a scope change in config means the stored token no longer matches what we need
	if (client.status === 'no_auth' || stored?.scope !== env.NODECRAFT_OAUTH_SCOPE) {
		await withTimeout(REQUEST_TIMEOUT_MS, () => client.clientCredentials());
	}
	return client;
}

// controller wraps payloads as { success, code, message, data }; nc_fetch_oauth throws when success is false
export async function controllerData<T>(client: ControllerClient, path: string, init?: RequestInit): Promise<T> {
	const response = await withTimeout<{ data: { data: T; }; }>(REQUEST_TIMEOUT_MS, () => client.request(path, init));
	return response.data.data;
}

interface NodecraftFetchError extends Error {
	code?: string;
	fields?: Record<string, unknown>;
}

function asNodecraftError(err: unknown): NodecraftFetchError | null {
	if (err instanceof Error && err.name === 'nc_fetchError') {
		return err as NodecraftFetchError;
	}
	return null;
}

export function nodecraftErrorCode(err: unknown): string | null {
	return asNodecraftError(err)?.code ?? null;
}

export function nodecraftErrorFields(err: unknown): Record<string, unknown> {
	return asNodecraftError(err)?.fields ?? {};
}
