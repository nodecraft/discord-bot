import {
	ButtonStyle,
	ComponentType,
	MessageFlags,
	SeparatorSpacingSize,
} from 'discord-api-types/v10';

import { describeServer } from './status.ts';
import { customId, parseCustomId } from '../../discord/types.ts';

import type { SharedServer } from './api.ts';
import type { GameArt } from './games.ts';
import type { ServerState } from './status.ts';
import type { APIButtonComponent, APIComponentInContainer, APIMessageTopLevelComponent } from 'discord-api-types/v10';

export const FEATURE = 'lite';

const STATES: Record<ServerState, { emoji: string; label: string; color: number; }> = {
	hibernating: { emoji: '💤', label: 'Hibernating', color: 0x6B_72_80 },
	hibernating_soon: { emoji: '🌇', label: 'Preparing to hibernate', color: 0xF5_9E_0B },
	offline: { emoji: '⚫', label: 'Offline', color: 0x6B_72_80 },
	online: { emoji: '🟢', label: 'Online', color: 0x22_C5_5E },
	ready: { emoji: '☀️', label: 'Ready', color: 0x3B_82_F6 },
	saving: { emoji: '🌙', label: 'Saving to hibernate', color: 0xF5_9E_0B },
	starting: { emoji: '🔄', label: 'Starting', color: 0x3B_82_F6 },
	stopping: { emoji: '🛑', label: 'Stopping', color: 0x6B_72_80 },
	waking: { emoji: '🌅', label: 'Waking', color: 0x3B_82_F6 },
};

// the wake path, drawn like the status track on nodepanel's share page
const TRACK: ServerState[] = ['hibernating', 'waking', 'starting', 'online'];

const JOINABLE_STATES: Set<ServerState> = new Set(['online', 'starting', 'hibernating_soon']);
const DISCORD_URL = /^https:\/\/discord\.(?:com|gg)\//;
const HTTPS_URL = /^https:\/\//;

export interface CardMessage {
	flags: number;
	components: APIMessageTopLevelComponent[];
	allowed_mentions: { parse: []; };
}

export interface CardOptions {
	cardId: string;
	// panels are pinned and seen often, so they get the game banner; cards in chat stay compact
	layout?: 'card' | 'panel';
	game?: GameArt | null;
	note?: string | null;
	// set while a wake is in flight, before controller reports the new state
	progress?: { state: 'starting' | 'waking'; since: number; };
	updatedAt?: number;
}

function escapeMarkdown(text: string): string {
	return text.replaceAll(/[\\*_`~|>#[\]]/g, String.raw`\$&`);
}

function timestamp(ms: number): string {
	return `<t:${Math.floor(ms / 1000)}:R>`;
}

function container(color: number, children: APIComponentInContainer[]): CardMessage {
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [{ type: ComponentType.Container, accent_color: color, components: children }],
		// server names are user-controlled, so never let a card ping anyone
		allowed_mentions: { parse: [] },
	};
}

function header(title: string, game: GameArt | null | undefined): APIComponentInContainer {
	let subtitle = 'Nodecraft Lite';
	if (game) {
		subtitle = `${escapeMarkdown(game.name)} · Nodecraft Lite`;
	}
	const text = { type: ComponentType.TextDisplay, content: `### ${escapeMarkdown(title)}\n-# ${subtitle}` } as const;
	if (!game?.icon) {
		return text;
	}
	return {
		type: ComponentType.Section,
		components: [text],
		accessory: { type: ComponentType.Thumbnail, media: { url: game.icon }, description: game.name },
	};
}

function playersText(server: SharedServer, state: ServerState): string {
	if (typeof server.players !== 'number' || state !== 'online') {
		return '';
	}
	if (server.players === 0) {
		return ' · No one playing yet';
	}
	if (server.players === 1) {
		return ' · 1 player';
	}
	return ` · ${server.players} players`;
}

function track(current: ServerState): string {
	const steps = TRACK.map((step) => {
		const display = STATES[step];
		if (step === current) {
			return `**${display.emoji} ${display.label}**`;
		}
		return display.emoji;
	});
	return `-# ${steps.join(' ─ ')}`;
}

function refreshButton(cardId: string, disabled: boolean): APIButtonComponent {
	return {
		type: ComponentType.Button,
		style: ButtonStyle.Secondary,
		emoji: { name: '🔄' },
		label: 'Refresh',
		custom_id: customId(FEATURE, 'refresh', cardId),
		disabled,
	};
}

// only panels can be edited after an interaction token expires, so cards in chat say how to get fresh status
function footer(updatedAt: number, layout: CardOptions['layout']): APIComponentInContainer {
	let hint = 'Press Refresh for the latest';
	if (layout === 'panel') {
		hint = 'Updates automatically';
	}
	return { type: ComponentType.TextDisplay, content: `-# Updated ${timestamp(updatedAt)} · ${hint}` };
}

export function renderCard(server: SharedServer, options: CardOptions): CardMessage {
	const view = describeServer(server);
	let state = view.state;
	let action = view.action;
	let note = options.note ?? view.note;
	if (options.progress) {
		state = options.progress.state;
		action = null;
		note = options.note ?? `Started ${timestamp(options.progress.since)}. This usually takes a minute or two.`;
	}
	const display = STATES[state];

	const children: APIComponentInContainer[] = [];
	if (options.layout === 'panel' && options.game?.banner) {
		children.push({ type: ComponentType.MediaGallery, items: [{ media: { url: options.game.banner }, description: options.game.name }] });
	}
	children.push(header(server.name, options.game));
	children.push({ type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small });

	const status = [`${display.emoji} **${display.label}**${playersText(server, state)}`];
	if (view.joinAddress && JOINABLE_STATES.has(state)) {
		// a code block gets Discord's copy button on desktop
		status.push(`\`\`\`\n${view.joinAddress}\n\`\`\``);
	}
	if (options.progress) {
		status.push(track(state));
	}
	if (note) {
		status.push(`-# ${note}`);
	}
	children.push({ type: ComponentType.TextDisplay, content: status.join('\n') });

	const buttons: APIButtonComponent[] = [];
	if (action) {
		buttons.push({
			type: ComponentType.Button,
			style: ButtonStyle.Success,
			emoji: { name: '⚡' },
			label: action === 'wake' ? 'Wake' : 'Start',
			custom_id: customId(FEATURE, 'wake', options.cardId),
		});
	}
	// the card refreshes itself during a wake, so manual refreshes would only add load
	buttons.push(refreshButton(options.cardId, Boolean(options.progress)));
	if (server.join_article && HTTPS_URL.test(server.join_article) && JOINABLE_STATES.has(state)) {
		buttons.push({ type: ComponentType.Button, style: ButtonStyle.Link, label: 'How to join', url: server.join_article });
	}
	if (server.jit_share_discord_url && DISCORD_URL.test(server.jit_share_discord_url)) {
		buttons.push({ type: ComponentType.Button, style: ButtonStyle.Link, label: 'Contact owner', url: server.jit_share_discord_url });
	}
	children.push({ type: ComponentType.Separator, divider: false, spacing: SeparatorSpacingSize.Small });
	children.push({ type: ComponentType.ActionRow, components: buttons });
	children.push(footer(options.updatedAt ?? Date.now(), options.layout));

	return container(display.color, children);
}

interface ComponentNode {
	type: number;
	custom_id?: string;
	components?: readonly ComponentNode[];
	accessory?: ComponentNode;
}

// cards have no text content, so a right-clicked card is recognised by the card id in its own buttons
export function findCardId(components: readonly ComponentNode[]): string | null {
	for (const component of components) {
		const parsed = component.custom_id ? parseCustomId(component.custom_id) : null;
		if (parsed?.feature === FEATURE && parsed.arg) {
			return parsed.arg;
		}
		const nested = [...(component.components ?? [])];
		if (component.accessory) {
			nested.push(component.accessory);
		}
		const found = findCardId(nested);
		if (found) {
			return found;
		}
	}
	return null;
}

// For cards that can't show a server, such as a locked or regenerated share link
export function renderNotice(text: string, cardId: string | null): CardMessage {
	const children: APIComponentInContainer[] = [{ type: ComponentType.TextDisplay, content: `-# Nodecraft Lite\n${text}` }];
	if (cardId) {
		children.push({ type: ComponentType.ActionRow, components: [refreshButton(cardId, false)] });
	}
	children.push(footer(Date.now(), 'card'));
	return container(STATES.offline.color, children);
}
