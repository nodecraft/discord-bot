import type { SharedServer } from './api.ts';
import type { GameArt } from './games.ts';

export type ServerState =
	| 'hibernating'
	| 'hibernating_soon'
	| 'offline'
	| 'online'
	| 'ready'
	| 'saving'
	| 'starting'
	| 'stopping'
	| 'waking';

export interface ServerView {
	state: ServerState;
	// what the card's primary button does; both go through the same share start route
	action: 'start' | 'wake' | null;
	joinAddress: string | null;
	note: string | null;
}

function joinAddress(server: SharedServer, game: GameArt | null | undefined): string | null {
	const network = server.network;
	if (!network) {
		return null;
	}
	// a Lite server's IP can change on wake, so prefer the DNS name unless the game can't join by hostname, matching nodepanel's shared page
	const dnsUnsupported = game?.joinFeatures && !game.joinFeatures.includes('dns');
	let host = network.address;
	if (network.hostname && network.domain && !dnsUnsupported) {
		host = `${network.hostname}.${network.domain}`;
	}
	if (!host) {
		return null;
	}
	if (server.default_port) {
		return `${host}:${server.default_port}`;
	}
	return host;
}

// Mirrors nodepanel's Lite labels (assets/entrypoints/shared/shared.ts) so users see the same words everywhere
export function describeServer(server: SharedServer, game?: GameArt | null): ServerView {
	const address = joinAddress(server, game);

	if (server.jit_status === 'storing') {
		return { state: 'saving', action: null, joinAddress: null, note: 'Saving to hibernate. Try again in a few minutes.' };
	}
	if (server.jit_status === 'stored') {
		if (!server.jit_available) {
			return { state: 'hibernating', action: null, joinAddress: null, note: 'This Lite plan is running another server right now.' };
		}
		return { state: 'hibernating', action: 'wake', joinAddress: null, note: null };
	}
	if (server.jit_status === 'waking') {
		return { state: 'waking', action: null, joinAddress: null, note: null };
	}

	if (server.status === 'online') {
		if (server.jit_status === 'ready_to_store') {
			return { state: 'hibernating_soon', action: null, joinAddress: address, note: 'No one has joined in a while. Join to keep it running.' };
		}
		return { state: 'online', action: null, joinAddress: address, note: null };
	}
	if (server.status === 'started') {
		return { state: 'starting', action: null, joinAddress: address, note: null };
	}
	if (server.status === 'stopping') {
		return { state: 'stopping', action: null, joinAddress: null, note: null };
	}
	if (server.jit_status === 'ready_to_store') {
		return { state: 'hibernating_soon', action: 'start', joinAddress: null, note: 'Hibernates soon unless someone starts it.' };
	}
	if (server.jit_status === 'hot') {
		return { state: 'ready', action: 'start', joinAddress: null, note: null };
	}
	return { state: 'offline', action: 'start', joinAddress: null, note: null };
}

// an idle server reaches ready_to_store while still online, often before anyone has had a chance to join after a wake
export function isServerUp(server: SharedServer): boolean {
	const state = describeServer(server).state;
	return state === 'online' || (state === 'hibernating_soon' && server.status === 'online');
}

// controller pushes every JIT step, but player counts never reach the bot that way, and a push can beat the heartbeat cache
const AWAKE_RECHECK_MS = 10 * 60000;

// When a pinned panel should next look at its server, or null once it's hibernating and controller's push will say when it wakes
export function nextPanelCheck(server: SharedServer, now: number): number | null {
	if (describeServer(server).state === 'hibernating') {
		return null;
	}
	return now + AWAKE_RECHECK_MS;
}
