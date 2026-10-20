import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';

const HOUR_MS = 60 * 60000;

describe('WakeWatcher cleanup', () => {
	it('deletes its storage once there is nothing left to watch', async () => {
		const stub = env.WAKE_WATCHER.getByName('idle-share');
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put('snapshot', { at: 0 });
			await state.storage.put('wakeLog', [Date.now() - (2 * HOUR_MS)]);
			await state.storage.setAlarm(Date.now() + HOUR_MS);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_instance, state) => {
			const stored = await state.storage.list();
			expect(stored.size).toBe(0);
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it('keeps the wake log until the budget window passes, so clearing storage can\'t reset the budget', async () => {
		const stub = env.WAKE_WATCHER.getByName('recently-woken-share');
		const lastWake = Date.now() - (10 * 60000);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put('wakeLog', [lastWake]);
			await state.storage.setAlarm(Date.now() + HOUR_MS);
		});
		await runDurableObjectAlarm(stub);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get('wakeLog')).toEqual([lastWake]);
			expect(await state.storage.getAlarm()).toBe(lastWake + HOUR_MS);
		});
	});

	it('keeps pinned panels even when their server is hibernating', async () => {
		const stub = env.WAKE_WATCHER.getByName('panel-share');
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put('panels', { card: { channelId: '1', messageId: '2' } });
		});
		await stub.unwatchPanel('other-card');
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get('panels')).toEqual({ card: { channelId: '1', messageId: '2' } });
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it('schedules cleanup when the last panel is removed', async () => {
		const stub = env.WAKE_WATCHER.getByName('last-panel-share');
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put('panels', { card: { channelId: '1', messageId: '2' } });
		});
		await stub.unwatchPanel('card');
		await runDurableObjectAlarm(stub);
		await runInDurableObject(stub, async (_instance, state) => {
			const stored = await state.storage.list();
			expect(stored.size).toBe(0);
		});
	});
});

describe('WakeWatcher with Pro share links', () => {
	const network = { address: '203.0.113.10', hostname: 'proworld', domain: 'nodecraft.gg' };
	const offline = { share_type: 'pro', name: 'Pro World', jit_available: true, status: 'offline', network, default_port: 25565 };
	const user = { userId: '200000000000000000', token: 'interaction-token', panel: false };

	// stands in for controller and Discord, recording what the watcher asked for
	function mockFetch(shared: () => Record<string, unknown>) {
		const calls = { starts: 0, pings: [] as string[] };
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			const { pathname } = new URL(request.url);
			if (pathname.endsWith('/start')) {
				calls.starts++;
				return Response.json({ success: true, code: 'instances.jit_started', data: {} });
			}
			if (pathname.startsWith('/v2/instance/shared/')) {
				return Response.json({ success: true, code: 'instances.jit_found', data: shared() });
			}
			if (request.method === 'POST') {
				const body = await request.json<{ content: string; }>();
				calls.pings.push(body.content);
			}
			return new Response(null, { status: 204 });
		});
		return calls;
	}

	beforeEach(async () => {
		const tokens = { access: 'test-access', accessExpires: new Date(Date.now() + HOUR_MS).toISOString(), scope: env.NODECRAFT_OAUTH_SCOPE };
		await env.DISCORD_BOT_SETTINGS.put(`oauth:${env.NODECRAFT_CLIENT_ID}`, JSON.stringify(tokens));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('starts an offline Pro server and pings whoever pressed Start once it is online', async () => {
		let shared: Record<string, unknown> = offline;
		const calls = mockFetch(() => shared);
		const stub = env.WAKE_WATCHER.getByName('pro-offline-share');
		expect(await stub.wake({ ...user, shareId: 'pro-offline-share', cardId: 'card-1' })).toEqual({ ok: true });
		expect(calls.starts).toBe(1);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get('wake')).toMatchObject({ progress: 'starting' });
		});

		shared = { ...offline, status: 'online' };
		await runDurableObjectAlarm(stub);
		expect(calls.pings).toEqual(['<@200000000000000000> your server is online. Join: `proworld.nodecraft.gg:25565`']);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get('wake')).toBeUndefined();
		});
	});

	it('never asks controller to start an archived Pro server', async () => {
		const calls = mockFetch(() => {
			return { ...offline, jit_available: false };
		});
		const stub = env.WAKE_WATCHER.getByName('pro-archived-share');
		expect(await stub.wake({ ...user, shareId: 'pro-archived-share', cardId: 'card-1' })).toEqual({ ok: true });
		expect(calls.starts).toBe(0);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get('wake')).toBeUndefined();
		});
	});

	it('stops waiting on a Pro server that gets archived partway through a start', async () => {
		let shared: Record<string, unknown> = offline;
		const calls = mockFetch(() => shared);
		const stub = env.WAKE_WATCHER.getByName('pro-archived-midway-share');
		await stub.wake({ ...user, shareId: 'pro-archived-midway-share', cardId: 'card-1' });

		shared = { ...offline, jit_available: false };
		await runDurableObjectAlarm(stub);
		expect(calls.pings).toEqual([]);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get('wake')).toBeUndefined();
		});
	});
});
