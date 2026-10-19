import { InteractionResponseType, MessageFlags } from 'discord-api-types/v10';

import type { APIInteractionResponse } from 'discord-api-types/v10';

export function ephemeralMessage(content: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.ChannelMessageWithSource,
		data: { content, flags: MessageFlags.Ephemeral },
	};
}

export function deferredMessage(ephemeral: boolean): APIInteractionResponse {
	if (ephemeral) {
		return {
			type: InteractionResponseType.DeferredChannelMessageWithSource,
			data: { flags: MessageFlags.Ephemeral },
		};
	}
	return { type: InteractionResponseType.DeferredChannelMessageWithSource };
}

export function deferredUpdate(): APIInteractionResponse {
	return { type: InteractionResponseType.DeferredMessageUpdate };
}
