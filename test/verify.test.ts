import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { sign } from './helpers.ts';
import { verifyDiscordRequest } from '../src/discord/verify.ts';

describe('verifyDiscordRequest', () => {
	it('accepts a valid signature', async () => {
		const signature = await sign('1700000000', '{"type":1}');
		expect(await verifyDiscordRequest(signature, '1700000000', '{"type":1}', env.DISCORD_PUBLIC_KEY)).toBe(true);
	});

	it('rejects a signature over a different timestamp', async () => {
		const signature = await sign('1700000000', '{"type":1}');
		expect(await verifyDiscordRequest(signature, '1700000001', '{"type":1}', env.DISCORD_PUBLIC_KEY)).toBe(false);
	});

	it('rejects missing or malformed headers without throwing', async () => {
		expect(await verifyDiscordRequest(undefined, '1700000000', '{}', env.DISCORD_PUBLIC_KEY)).toBe(false);
		expect(await verifyDiscordRequest('not-hex', '1700000000', '{}', env.DISCORD_PUBLIC_KEY)).toBe(false);
		expect(await verifyDiscordRequest('ab'.repeat(64), '1700000000', '{}', env.DISCORD_PUBLIC_KEY)).toBe(false);
	});
});
