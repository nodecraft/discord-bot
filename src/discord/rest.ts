import { withTimeout } from '../lib/timeout.ts';

import type { Env } from '../env.ts';
import type {
	RESTPatchAPIChannelMessageJSONBody,
	RESTPatchAPIWebhookWithTokenMessageJSONBody,
	RESTPostAPIChannelMessageJSONBody,
	RESTPostAPIChannelMessageResult,
	RESTPostAPIWebhookWithTokenJSONBody,
} from 'discord-api-types/v10';

const API_BASE = 'https://discord.com/api/v10';
const MAX_RETRY_AFTER_SECONDS = 5;
// a hung edit would otherwise hold up every other click on the same share's watcher
const REQUEST_TIMEOUT_MS = 10000;

export class DiscordApiError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`Discord API responded ${status}`);
		this.status = status;
		this.body = body;
	}
}

interface DiscordRequest {
	method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
	path: string;
	body?: unknown;
	botToken?: string;
}

function send(request: DiscordRequest): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'user-agent': 'DiscordBot (https://github.com/nodecraft/discord-bot, 1.0.0)',
	};
	if (request.botToken) {
		headers.authorization = `Bot ${request.botToken}`;
	}
	return withTimeout(REQUEST_TIMEOUT_MS, signal => fetch(`${API_BASE}${request.path}`, {
		method: request.method,
		headers,
		body: request.body === undefined ? undefined : JSON.stringify(request.body),
		signal,
	}));
}

async function discordFetch<T>(request: DiscordRequest): Promise<T> {
	let response = await send(request);
	if (response.status === 429) {
		const retryAfter = Number(response.headers.get('retry-after') ?? 1);
		// short waits are cheaper than failing the edit; long ones mean a real limit we shouldn't sit on
		if (retryAfter <= MAX_RETRY_AFTER_SECONDS) {
			await scheduler.wait(retryAfter * 1000);
			response = await send(request);
		}
	}
	if (!response.ok) {
		throw new DiscordApiError(response.status, await response.text());
	}
	if (response.status === 204) {
		return undefined as T;
	}
	return await response.json<T>();
}

export function editOriginalResponse(env: Env, token: string, body: RESTPatchAPIWebhookWithTokenMessageJSONBody) {
	return discordFetch<unknown>({
		method: 'PATCH',
		path: `/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`,
		body,
	});
}

export function createFollowup(env: Env, token: string, body: RESTPostAPIWebhookWithTokenJSONBody) {
	return discordFetch<unknown>({
		method: 'POST',
		path: `/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`,
		body,
	});
}

export function createChannelMessage(env: Env, channelId: string, body: RESTPostAPIChannelMessageJSONBody) {
	return discordFetch<RESTPostAPIChannelMessageResult>({
		method: 'POST',
		path: `/channels/${channelId}/messages`,
		body,
		botToken: env.DISCORD_BOT_TOKEN,
	});
}

export function getChannelMessage(env: Env, channelId: string, messageId: string) {
	return discordFetch<unknown>({
		method: 'GET',
		path: `/channels/${channelId}/messages/${messageId}`,
		botToken: env.DISCORD_BOT_TOKEN,
	});
}

export function deleteChannelMessage(env: Env, channelId: string, messageId: string) {
	return discordFetch<unknown>({
		method: 'DELETE',
		path: `/channels/${channelId}/messages/${messageId}`,
		botToken: env.DISCORD_BOT_TOKEN,
	});
}

// bot-posted messages (panels) stay editable forever, unlike interaction replies whose tokens expire after 15 minutes
export function editChannelMessage(env: Env, channelId: string, messageId: string, body: RESTPatchAPIChannelMessageJSONBody) {
	return discordFetch<unknown>({
		method: 'PATCH',
		path: `/channels/${channelId}/messages/${messageId}`,
		body,
		botToken: env.DISCORD_BOT_TOKEN,
	});
}
