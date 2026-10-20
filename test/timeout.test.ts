import { describe, expect, it } from 'vitest';

import { withTimeout } from '../src/lib/timeout.ts';

describe('withTimeout', () => {
	it('gives up on work that ignores the signal, as nc_fetch does', async () => {
		const hung = new Promise<never>(() => {});
		await expect(withTimeout(10, () => hung)).rejects.toThrow('Timed out after 10ms');
	});

	it('aborts the signal so a fetch can cancel its request', async () => {
		let seen: AbortSignal | undefined;
		await withTimeout(10, (signal) => {
			seen = signal;
			return new Promise<never>(() => {});
		}).catch(() => {});
		expect(seen?.aborted).toBe(true);
	});

	it('returns the result when the work finishes in time', async () => {
		expect(await withTimeout(1000, () => Promise.resolve('done'))).toBe('done');
	});
});
