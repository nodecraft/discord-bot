import { ApplicationIntegrationType } from 'discord-api-types/v10';

import type { Env } from '../env.ts';
import type {
	APIChatInputApplicationCommandInteraction,
	APIInteraction,
	APIInteractionResponse,
	APIMessageApplicationCommandInteraction,
	APIMessageComponentInteraction,
	APIModalSubmitInteraction,
} from 'discord-api-types/v10';

export interface InteractionContext {
	env: Env;
	waitUntil(promise: Promise<unknown>): void;
}

type Respond = APIInteractionResponse | Promise<APIInteractionResponse>;

export type SubcommandHandler = (interaction: APIChatInputApplicationCommandInteraction, ctx: InteractionContext) => Respond;
export type MessageCommandHandler = (interaction: APIMessageApplicationCommandInteraction, ctx: InteractionContext) => Respond;
export type ComponentHandler = (interaction: APIMessageComponentInteraction, ctx: InteractionContext, arg: string) => Respond;
export type ModalHandler = (interaction: APIModalSubmitInteraction, ctx: InteractionContext, arg: string) => Respond;

// Each product area (Lite today, more later) plugs in as a feature; `name` prefixes its custom_ids
export interface Feature {
	name: string;
	subcommands?: Record<string, SubcommandHandler>;
	messageCommands?: Record<string, MessageCommandHandler>;
	components?: Record<string, ComponentHandler>;
	modals?: Record<string, ModalHandler>;
}

export function customId(feature: string, action: string, arg: string): string {
	return `${feature}:${action}:${arg}`;
}

export function parseCustomId(value: string): { feature: string; action: string; arg: string; } | null {
	const [feature, action, ...rest] = value.split(':');
	if (!feature || !action) {
		return null;
	}
	return { feature, action, arg: rest.join(':') };
}

// bot-token actions like posting panels only work where the app is installed to the server, not just the user
export function isInstalledInGuild(interaction: APIInteraction): boolean {
	if (!interaction.guild_id) {
		return false;
	}
	return interaction.authorizing_integration_owners[ApplicationIntegrationType.GuildInstall] === interaction.guild_id;
}

export function interactionUserId(interaction: { member?: { user: { id: string; }; }; user?: { id: string; }; }): string {
	const userId = interaction.member?.user.id ?? interaction.user?.id;
	if (!userId) {
		throw new Error('Interaction has no user');
	}
	return userId;
}
