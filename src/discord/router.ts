import {
	ApplicationCommandOptionType,
	ApplicationCommandType,
	InteractionResponseType,
	InteractionType,
} from 'discord-api-types/v10';

import { ROOT_COMMAND } from '../commands.ts';
import { ephemeralMessage } from './responses.ts';
import { parseCustomId } from './types.ts';
import { features } from '../features/index.ts';

import type { InteractionContext } from './types.ts';
import type {
	APIApplicationCommandInteraction,
	APIChatInputApplicationCommandInteraction,
	APIInteraction,
	APIInteractionResponse,
} from 'discord-api-types/v10';

const UNKNOWN_ACTION = 'That action is no longer available. Try running the command again.';

const featuresByName = new Map(features.map(feature => [feature.name, feature]));

// Subcommand groups route as "group.subcommand", so features can nest commands later without router changes
function subcommandKey(interaction: APIChatInputApplicationCommandInteraction): string | null {
	const [option] = interaction.data.options ?? [];
	if (!option) {
		return null;
	}
	if (option.type === ApplicationCommandOptionType.Subcommand) {
		return option.name;
	}
	if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
		const [subcommand] = option.options;
		if (subcommand) {
			return `${option.name}.${subcommand.name}`;
		}
	}
	return null;
}

function handleCommand(interaction: APIApplicationCommandInteraction, ctx: InteractionContext) {
	if (interaction.data.type === ApplicationCommandType.ChatInput) {
		const chatInput = interaction as APIChatInputApplicationCommandInteraction;
		if (chatInput.data.name !== ROOT_COMMAND) {
			return ephemeralMessage(UNKNOWN_ACTION);
		}
		const key = subcommandKey(chatInput);
		for (const feature of features) {
			const handler = key ? feature.subcommands?.[key] : undefined;
			if (handler) {
				return handler(chatInput, ctx);
			}
		}
	}
	if (interaction.data.type === ApplicationCommandType.Message) {
		for (const feature of features) {
			const handler = feature.messageCommands?.[interaction.data.name];
			if (handler) {
				return handler(interaction as Parameters<typeof handler>[0], ctx);
			}
		}
	}
	return ephemeralMessage(UNKNOWN_ACTION);
}

async function dispatch(interaction: APIInteraction, ctx: InteractionContext): Promise<APIInteractionResponse> {
	switch (interaction.type) {
		case InteractionType.Ping: {
			return { type: InteractionResponseType.Pong };
		}
		case InteractionType.ApplicationCommand: {
			return handleCommand(interaction, ctx);
		}
		case InteractionType.MessageComponent: {
			const parsed = parseCustomId(interaction.data.custom_id);
			const handler = parsed ? featuresByName.get(parsed.feature)?.components?.[parsed.action] : undefined;
			if (!parsed || !handler) {
				return ephemeralMessage(UNKNOWN_ACTION);
			}
			return handler(interaction, ctx, parsed.arg);
		}
		case InteractionType.ModalSubmit: {
			const parsed = parseCustomId(interaction.data.custom_id);
			const handler = parsed ? featuresByName.get(parsed.feature)?.modals?.[parsed.action] : undefined;
			if (!parsed || !handler) {
				return ephemeralMessage(UNKNOWN_ACTION);
			}
			return handler(interaction, ctx, parsed.arg);
		}
		default: {
			return ephemeralMessage(UNKNOWN_ACTION);
		}
	}
}

// Cloudflare's rate limiter is per location and eventually consistent, which is fine for stopping floods rather than exact quotas
async function isRateLimited(interaction: APIInteraction, ctx: InteractionContext): Promise<boolean> {
	if (interaction.type === InteractionType.Ping) {
		return false;
	}
	const checks: Promise<RateLimitOutcome>[] = [];
	const userId = interaction.member?.user.id ?? interaction.user?.id;
	if (userId) {
		checks.push(ctx.env.USER_RATE_LIMIT.limit({ key: userId }));
	}
	if (interaction.guild_id) {
		checks.push(ctx.env.GUILD_RATE_LIMIT.limit({ key: interaction.guild_id }));
	}
	const outcomes = await Promise.all(checks);
	return outcomes.some(outcome => !outcome.success);
}

export async function handleInteraction(interaction: APIInteraction, ctx: InteractionContext): Promise<APIInteractionResponse> {
	try {
		if (await isRateLimited(interaction, ctx)) {
			return ephemeralMessage('That\'s a lot of requests in a short time. Give it a minute and try again.');
		}
		return await dispatch(interaction, ctx);
	} catch (err) {
		console.error('Interaction handler failed', err);
		return ephemeralMessage('Something went wrong. Try again in a moment.');
	}
}
