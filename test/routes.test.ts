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
