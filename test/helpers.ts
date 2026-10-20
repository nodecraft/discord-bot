import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

import worker from '../src/index.ts';

import type { Env } from '../src/env.ts';

// test-only key; its public half is DISCORD_PUBLIC_KEY in vitest.config.ts
const TEST_PRIVATE_KEY = 'MC4CAQAwBQYDK2VwBCIEIBru4G9nwUIZqOBj8NwNADtykp+hAn97uvagmAXRfrOA';

let privateKey: Promise<CryptoKey> | null = null;

function getPrivateKey(): Promise<CryptoKey> {
	if (!privateKey) {
		const der = Uint8Array.from(atob(TEST_PRIVATE_KEY), char => char.codePointAt(0) ?? 0);
		privateKey = crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
	}
	return privateKey;
}

function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sign(timestamp: string, body: string): Promise<string> {
	const signature = await crypto.subtle.sign({ name: 'Ed25519' }, await getPrivateKey(), new TextEncoder().encode(timestamp + body));
	return toHex(signature);
}

export async function postInteraction(payload: unknown, headers: Record<string, string> = {}, bindings: Partial<Env> = {}): Promise<Response> {
	const body = JSON.stringify(payload);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const request = new Request('http://localhost/interactions', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-signature-ed25519': await sign(timestamp, body),
			'x-signature-timestamp': timestamp,
			...headers,
		},
		body,
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, ...bindings }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}
