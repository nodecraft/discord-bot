import { InteractionContextType, InteractionType } from 'discord-api-types/v10';

import { isInstalledInGuild } from '../discord/types.ts';

import type { Env } from '../env.ts';
import type { APIInteraction } from 'discord-api-types/v10';

// Analytics Engine columns are positional (blob1, double1...), so these orders are a contract with the Grafana dashboards.
// Only ever append new fields; reordering or removing one breaks every query and mixes old and new data. Max 20 of each.

export interface TechnicalPoint {
	// request: an HTTP request; task: deferred work after replying to Discord; alarm: a WakeWatcher alarm
	type: 'alarm' | 'request' | 'task';
	// route path, task name or alarm job
	name: string;
	outcome: string;
	durationMs: number;
	action?: string;
	status?: number;
	request?: Request;
	interaction?: APIInteraction;
}

export interface ProductEvent {
	event: 'help' | 'password_prompt' | 'refresh' | 'share' | 'wake' | 'wake_finished';
	outcome?: string;
	shareId?: string;
	module?: string | null;
	// how the user got here, like the share command or right-clicking a message
	source?: string;
	layout?: 'card' | 'panel';
	passwordMode?: string;
	durationMs?: number;
}

const CONTEXTS: Record<InteractionContextType, string> = {
	[InteractionContextType.Guild]: 'guild',
	[InteractionContextType.BotDM]: 'bot_dm',
	[InteractionContextType.PrivateChannel]: 'private_channel',
};

// Discord calls us from its own servers, so request geo is Discord's; locale is the only hint of where the user is
function interactionFields(interaction: APIInteraction | undefined) {
	if (!interaction || interaction.type === InteractionType.Ping) {
		return { locale: '', context: '', install: '', guildId: '', userId: '' };
	}
	let context = '';
	if (interaction.context !== undefined) {
		context = CONTEXTS[interaction.context];
	}
	let install = 'user';
	if (isInstalledInGuild(interaction)) {
		install = 'guild';
	}
	return {
		locale: interaction.locale,
		context,
		install,
		guildId: interaction.guild_id ?? '',
		userId: interaction.member?.user.id ?? interaction.user?.id ?? '',
	};
}

function write(dataset: AnalyticsEngineDataset | undefined, point: AnalyticsEngineDataPoint) {
	// analytics must never fail the work it describes
	try {
		dataset?.writeDataPoint(point);
	} catch (err) {
		console.error('Analytics write failed', err);
	}
}

export function trackTechnical(env: Env, point: TechnicalPoint): void {
	const cf = point.request?.cf;
	const origin = interactionFields(point.interaction);
	write(env.TECHNICAL_ANALYTICS, {
		blobs: [
			point.type,
			point.name,
			point.action ?? '',
			point.outcome,
			point.request?.method ?? '',
			(cf?.country as string | undefined) ?? '',
			(cf?.colo as string | undefined) ?? '',
			(cf?.city as string | undefined) ?? '',
			point.request?.headers.get('user-agent') ?? '',
			point.request?.headers.get('referer') ?? '',
			origin.locale,
			origin.context,
			origin.install,
		],
		doubles: [
			point.status ?? 0,
			point.durationMs,
			(cf?.asn as number | undefined) ?? 0,
		],
		indexes: [point.type],
	});
}

export function trackEvent(env: Env, event: ProductEvent, interaction?: APIInteraction): void {
	const origin = interactionFields(interaction);
	write(env.PRODUCT_ANALYTICS, {
		blobs: [
			event.event,
			event.outcome ?? '',
			event.shareId ?? '',
			event.module ?? '',
			event.source ?? '',
			event.layout ?? '',
			event.passwordMode ?? '',
			origin.guildId,
			origin.userId,
			origin.locale,
			origin.context,
			origin.install,
		],
		doubles: [event.durationMs ?? 0],
		// sampling keeps per-index counts and the number of distinct indexes accurate, which is what "unique servers" needs
		indexes: [event.shareId || event.event],
	});
}
