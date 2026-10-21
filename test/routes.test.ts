import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import worker from '../src/index.ts';

async function get(path: string): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://localhost${path}`, { redirect: 'manual' }), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function push(body: unknown, secret = 'test-push-secret'): Promise<number> {
	const ctx = createExecutionContext();
	const request = new Request('http://localhost/lite/updates', {
		method: 'POST',
		headers: { 'authorization': `Bearer ${secret}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	await response.text();
	return response.status;
}

describe('controller pushes', () => {
	const shareId = '0f8fad5b-d9cb-469f-a165-70867728950e';

	it('rejects pushes without the shared secret', async () => {
		expect(await push({ share_id: shareId }, 'wrong-secret')).toBe(401);
	});

	it('rejects pushes that are not for a share ID', async () => {
		expect(await push({ share_id: 'not-a-share' })).toBe(400);
		expect(await push({})).toBe(400);
	});

	it('accepts a push for a share', async () => {
		expect(await push({ share_id: shareId })).toBe(202);
	});
});

describe('hostname routes', () => {
	it('keeps redirecting existing discord.nodecraft.com links to the community server', async () => {
		for (const path of ['/', '/support', '/?ref=nodepanel']) {
			const response = await get(path);
			expect(response.status).toBe(301);
			expect(response.headers.get('location')).toBe('https://discord.gg/nodecraft');
			await response.text();
		}
	});

	it('still serves the health check', async () => {
		const response = await get('/health');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});

	it('sends /install to Discord\'s install page for this app, so nodepanel never needs the app id', async () => {
		const response = await get('/install');
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://discord.com/oauth2/authorize?client_id=100000000000000000');
		await response.text();
	});
});
