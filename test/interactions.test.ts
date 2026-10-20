import { describe, expect, it } from 'vitest';

import { postInteraction } from './helpers.ts';

const user = { id: '200000000000000000', username: 'tester' };

function shareCommand(options: { name: string; type: number; value: boolean | string; }[], extra: Record<string, unknown> = {}) {
	return {
		id: '1',
		application_id: '100000000000000000',
		type: 2,
		token: 'interaction-token',
		version: 1,
		channel: { id: '300000000000000000', type: 1 },
		user,
		authorizing_integration_owners: { 1: user.id },
		data: {
			id: '2',
			name: 'nodecraft',
			type: 1,
			options: [{ type: 1, name: 'share', options }],
		},
		...extra,
	};
}

describe('interactions endpoint', () => {
	it('rejects a tampered body with 401', async () => {
		const response = await postInteraction({ type: 1 }, { 'x-signature-timestamp': '0' });
		expect(response.status).toBe(401);
		await response.text();
	});

	it('answers a signed PING with PONG', async () => {
		const response = await postInteraction({ type: 1 });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 1 });
	});

	it('replies privately when the share link is not a Nodecraft link', async () => {
		const response = await postInteraction(shareCommand([{ name: 'link', type: 3, value: 'https://example.com/nope' }]));
		const body = await response.json<{ type: number; data: { flags: number; content: string; }; }>();
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain('isn\'t a Nodecraft share link');
	});

	it('explains how to share a server, privately, on /nodecraft help', async () => {
		const response = await postInteraction({
			...shareCommand([]),
			data: { id: '2', name: 'nodecraft', type: 1, options: [{ type: 1, name: 'help' }] },
		});
		const body = await response.json<{ type: number; data: { flags: number; content: string; }; }>();
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain('/nodecraft share link:');
	});

	it('refuses a panel when the app is only user-installed', async () => {
		const response = await postInteraction(shareCommand(
			[
				{ name: 'link', type: 3, value: 'https://app.nodecraft.com/shared/d1281851-20e3-4d94-aef3-26b68106996a' },
				{ name: 'panel', type: 5, value: true },
			],
			{ guild_id: '400000000000000000' },
		));
		const body = await response.json<{ type: number; data: { flags: number; content: string; }; }>();
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
		expect(body.data.content).toContain('add Nodecraft to this server');
	});

	it('answers an unknown button privately instead of failing', async () => {
		const response = await postInteraction({
			id: '1',
			application_id: '100000000000000000',
			type: 3,
			token: 'interaction-token',
			version: 1,
			user,
			authorizing_integration_owners: { 1: user.id },
			data: { custom_id: 'retired:thing:1', component_type: 2 },
		});
		const body = await response.json<{ type: number; data: { flags: number; }; }>();
		expect(body.type).toBe(4);
		expect(body.data.flags).toBe(64);
	});

	it('turns away a user who floods the bot, before any feature work runs', async () => {
		const flooder = { id: '200000000000000099', username: 'flooder' };
		const click = () => postInteraction({
			id: '1',
			application_id: '100000000000000000',
			type: 3,
			token: 'interaction-token',
			version: 1,
			user: flooder,
			authorizing_integration_owners: { 1: flooder.id },
			data: { custom_id: 'retired:thing:1', component_type: 2 },
		});
		const reply = async () => {
			const response = await click();
			const body = await response.json<{ data: { content: string; }; }>();
			return body.data.content;
		};
		for (let attempt = 0; attempt < 10; attempt++) {
			expect(await reply()).not.toContain('a lot of requests');
		}
		expect(await reply()).toContain('a lot of requests');
	});
});
