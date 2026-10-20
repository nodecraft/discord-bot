import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

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
