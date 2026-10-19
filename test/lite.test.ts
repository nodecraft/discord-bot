import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { renderCard } from '../src/features/lite/cards.ts';
import { findShareId, parseShareInput } from '../src/features/lite/share-link.ts';
import { describeServer, nextPanelCheck } from '../src/features/lite/status.ts';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.ts';

import type { SharedServer } from '../src/features/lite/api.ts';

const SHARE_ID = 'd1281851-20e3-4d94-aef3-26b68106996a';

function server(overrides: Partial<SharedServer>): SharedServer {
	return {
		name: 'My Survival World',
		jit_status: 'live',
		jit_available: true,
		network: { address: '203.0.113.10', hostname: 'mysurvival', domain: 'nodecraft.gg' },
		default_port: 25565,
		status: 'online',
		...overrides,
	};
}

describe('share links', () => {
	it('finds a share link inside a chat message', () => {
		expect(findShareId(`wake it here: https://app.nodecraft.com/shared/${SHARE_ID.toUpperCase()} thanks`)).toBe(SHARE_ID);
	});

	it('accepts a bare share ID as command input but not in free text', () => {
		expect(parseShareInput(` ${SHARE_ID} `)).toBe(SHARE_ID);
		expect(findShareId(SHARE_ID)).toBeNull();
	});

	it('ignores look-alike links on other domains', () => {
		expect(findShareId(`https://nodecraft.com.evil.example/shared/${SHARE_ID}`)).toBeNull();
	});
});

describe('describeServer', () => {
	it('offers Wake for a hibernating server only when its Lite plan is free', () => {
		expect(describeServer(server({ jit_status: 'stored', status: 'offline' })).action).toBe('wake');
		const busy = describeServer(server({ jit_status: 'stored', status: 'offline', jit_available: false }));
		expect(busy.action).toBeNull();
		expect(busy.note).toContain('another server');
	});

	it('offers Start for a hot server that is offline', () => {
		expect(describeServer(server({ jit_status: 'hot', status: 'offline' }))).toMatchObject({ state: 'ready', action: 'start' });
	});

	it('shows the DNS name rather than the IP, since Lite IPs change on wake', () => {
		expect(describeServer(server({})).joinAddress).toBe('mysurvival.nodecraft.gg:25565');
	});

	it('has nothing to press while saving to hibernate', () => {
		expect(describeServer(server({ jit_status: 'storing', status: 'offline' }))).toMatchObject({ state: 'saving', action: null });
	});
});

describe('renderCard', () => {
	it('escapes markdown in server names so owners cannot inject formatting or mentions', () => {
		const card = renderCard(server({ name: '**@everyone**' }), { cardId: 'card-1' });
		expect(JSON.stringify(card)).toContain(String.raw`\\*\\*@everyone\\*\\*`);
		expect(card.allowed_mentions).toEqual({ parse: [] });
	});

	it('keeps share IDs out of button custom_ids', () => {
		const card = renderCard(server({ jit_status: 'stored', status: 'offline' }), { cardId: 'card-1' });
		expect(JSON.stringify(card)).not.toContain(SHARE_ID);
		expect(JSON.stringify(card)).toContain('lite:wake:card-1');
	});

	const game = { name: 'Minecraft', icon: 'https://cms-a.nodecraft.com/icon.png/m/256x256/smart', banner: 'https://cms-a.nodecraft.com/banner.png/m/1200x400/smart' };

	it('shows the game banner on pinned panels but keeps chat cards compact', () => {
		const panel = JSON.stringify(renderCard(server({}), { cardId: 'card-1', layout: 'panel', game }));
		const card = JSON.stringify(renderCard(server({}), { cardId: 'card-1', layout: 'card', game }));
		expect(panel).toContain(game.banner);
		expect(card).not.toContain(game.banner);
		expect(card).toContain(game.icon);
	});

	it('disables Refresh while a wake is updating the card by itself', () => {
		const card = renderCard(server({ jit_status: 'stored', status: 'offline' }), {
			cardId: 'card-1',
			progress: { state: 'waking', since: Date.now() },
		});
		const buttons = JSON.stringify(card);
		const parsed = JSON.parse(buttons) as { components: { components: { components?: { custom_id?: string; disabled?: boolean; }[]; }[]; }[]; };
		const refresh = parsed.components[0]?.components.flatMap(child => child.components ?? []).find(button => button.custom_id === 'lite:refresh:card-1');
		expect(refresh?.disabled).toBe(true);
		expect(buttons).not.toContain('lite:wake:card-1');
	});

	it('only reports players for a server that is online', () => {
		expect(JSON.stringify(renderCard(server({ players: 3 }), { cardId: 'card-1' }))).toContain('3 players');
		expect(JSON.stringify(renderCard(server({ players: 3, jit_status: 'stored', status: 'offline' }), { cardId: 'card-1' }))).not.toContain('players');
	});
});

describe('secret encryption', () => {
	it('round-trips with the same context', async () => {
		const sealed = await encryptSecret(env.CARD_ENCRYPTION_KEY, 'hunter2', 'card-1');
		expect(await decryptSecret(env.CARD_ENCRYPTION_KEY, sealed, 'card-1')).toBe('hunter2');
	});

	it('refuses to decrypt a ciphertext moved to another card', async () => {
		const sealed = await encryptSecret(env.CARD_ENCRYPTION_KEY, 'hunter2', 'card-1');
		await expect(decryptSecret(env.CARD_ENCRYPTION_KEY, sealed, 'card-2')).rejects.toThrow();
	});
});

describe('nextPanelCheck', () => {
	const now = Date.parse('2026-10-20T12:00:00Z');

	it('stops checking once the server is hibernating, since only a click can change it', () => {
		expect(nextPanelCheck(server({ jit_status: 'stored', status: 'offline' }), now)).toBeNull();
	});

	it('aims just past the expiry, which is when controller moves an idle server toward hibernation', () => {
		const expires = '2026-10-20T12:20:00Z';
		expect(nextPanelCheck(server({ jit_status: 'hot', jit_expires_date: expires }), now)).toBe(Date.parse(expires) + 30000);
	});

	it('backs off to every 5 minutes when the expiry is stale, such as a locked server the idle scan skips', () => {
		expect(nextPanelCheck(server({ jit_status: 'ready_to_store', jit_expires_date: '2026-10-20T11:00:00Z' }), now)).toBe(now + 300000);
	});

	it('waits at least a minute even when the expiry is moments away', () => {
		expect(nextPanelCheck(server({ jit_status: 'hot', jit_expires_date: '2026-10-20T12:00:05Z' }), now)).toBe(now + 60000);
	});

	it('checks in every 10 minutes while players keep a server live', () => {
		expect(nextPanelCheck(server({ jit_status: 'live', jit_expires_date: null }), now)).toBe(now + 600000);
	});
});
