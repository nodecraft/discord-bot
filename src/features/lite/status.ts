import type { SharedServer } from './api.ts';

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

function joinAddress(server: SharedServer): string | null {
	const network = server.network;
	if (!network) {
		return null;
	}
	// a Lite server's IP can change on wake, so prefer the DNS name when there is one
	let host = network.address;
	if (network.hostname && network.domain) {
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
export function describeServer(server: SharedServer): ServerView {
	const address = joinAddress(server);

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

const MINUTE_MS = 60000;
// controller's idle scan runs every 5 minutes, so give it a moment past the expiry before looking
const EXPIRY_GRACE_MS = 30000;
// while players keep a server live there's no expiry to aim at, so check in occasionally
const LIVE_RECHECK_MS = 10 * MINUTE_MS;
const SAVING_RECHECK_MS = 2 * MINUTE_MS;
// an expiry already in the past (a locked server the idle scan skips, or a slow scan) would otherwise mean a check every minute forever
const STALE_EXPIRY_RECHECK_MS = 5 * MINUTE_MS;
// wakes from nodepanel or the dashboard never reach the bot, so a slow check keeps hibernating panels from going stale
const HIBERNATING_RECHECK_MS = 120 * MINUTE_MS;

// When a pinned panel should next look at its server
export function nextPanelCheck(server: SharedServer, now: number): number {
	const { state } = describeServer(server);
	if (state === 'hibernating') {
		return now + HIBERNATING_RECHECK_MS;
	}
	if (state === 'saving') {
		return now + SAVING_RECHECK_MS;
	}
	let expires = NaN;
	if (server.jit_expires_date) {
		expires = Date.parse(server.jit_expires_date);
	}
	if (!Number.isFinite(expires)) {
		return now + LIVE_RECHECK_MS;
	}
	if (expires + EXPIRY_GRACE_MS <= now) {
		return now + STALE_EXPIRY_RECHECK_MS;
	}
	return Math.max(expires + EXPIRY_GRACE_MS, now + MINUTE_MS);
}
