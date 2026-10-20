import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { postInteraction } from './helpers.ts';
import worker from '../src/index.ts';

const user = { id: '200000000000000000', username: 'tester' };

const helpCommand = {
	id: '1',
	application_id: '100000000000000000',
	type: 2,
	token: 'interaction-token',
	version: 1,
	locale: 'pt-BR',
	context: 1,
	channel: { id: '300000000000000000', type: 1 },
	user,
	authorizing_integration_owners: { 1: user.id },
	data: { id: '2', name: 'nodecraft', type: 1, options: [{ type: 1, name: 'help' }] },
};

function recorder() {
	const points: AnalyticsEngineDataPoint[] = [];
	const dataset = {
		writeDataPoint: (point: AnalyticsEngineDataPoint) => {
			points.push(point);
		},
	};
	return { points, dataset };
}

describe('analytics', () => {
	// the Grafana dashboards read these by position (blob1, blob2...), so a reorder would silently break them
	it('records an interaction request and its product event in the columns the dashboards query', async () => {
		const technical = recorder();
		const product = recorder();
		const response = await postInteraction(helpCommand, {}, { TECHNICAL_ANALYTICS: technical.dataset, PRODUCT_ANALYTICS: product.dataset });
		await response.text();

		expect(technical.points).toHaveLength(1);
		const [request] = technical.points;
		expect(request?.blobs?.slice(0, 4)).toEqual(['request', '/interactions', 'help', 'ok']);
		expect(request?.blobs?.slice(10, 13)).toEqual(['pt-BR', 'bot_dm', 'user']);
		expect(request?.doubles?.[0]).toBe(200);
		expect(request?.indexes).toEqual(['request']);

		expect(product.points).toHaveLength(1);
		const [event] = product.points;
		expect(event?.blobs?.[0]).toBe('help');
		expect(event?.blobs?.slice(8, 12)).toEqual([user.id, 'pt-BR', 'bot_dm', 'user']);
	});

	it('records a bad signature as its own outcome', async () => {
		const technical = recorder();
		const response = await postInteraction({ type: 1 }, { 'x-signature-timestamp': '0' }, { TECHNICAL_ANALYTICS: technical.dataset });
		await response.text();
		expect(technical.points[0]?.blobs?.[3]).toBe('bad_signature');
		expect(technical.points[0]?.doubles?.[0]).toBe(401);
	});

	it('groups unmatched paths together, so arbitrary URLs can\'t flood the route breakdown', async () => {
		const technical = recorder();
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request('http://localhost/some/random/path'), { ...env, TECHNICAL_ANALYTICS: technical.dataset }, ctx);
		await waitOnExecutionContext(ctx);
		await response.text();
		expect(technical.points[0]?.blobs?.[1]).toBe('not_found');
	});

	it('still answers Discord when analytics writes fail', async () => {
		const failing = {
			writeDataPoint: () => {
				throw new Error('dataset unavailable');
			},
		};
		const response = await postInteraction(helpCommand, {}, { TECHNICAL_ANALYTICS: failing, PRODUCT_ANALYTICS: failing });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ type: 4 });
	});
});
