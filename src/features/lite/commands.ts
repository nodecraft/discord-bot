import { ApplicationCommandOptionType } from 'discord-api-types/v10';

import type { APIApplicationCommandSubcommandOption } from 'discord-api-types/v10';

export const SHARE_SUBCOMMAND = 'share';
export const START_MESSAGE_COMMAND = 'Start Nodecraft server';
// still routed, since Discord clients can hold on to the old command name for a while after it's re-registered
export const LEGACY_WAKE_MESSAGE_COMMAND = 'Wake Lite server';

export const SHARE_OPTIONS = {
	link: 'link',
	password: 'password',
	panel: 'panel',
} as const;

export const liteSubcommands: APIApplicationCommandSubcommandOption[] = [
	{
		type: ApplicationCommandOptionType.Subcommand,
		name: SHARE_SUBCOMMAND,
		description: 'Post a server card from its share link so anyone here can start it',
		options: [
			{
				type: ApplicationCommandOptionType.String,
				name: SHARE_OPTIONS.link,
				description: 'The share link, like https://app.nodecraft.com/shared/...',
				required: true,
			},
			{
				type: ApplicationCommandOptionType.String,
				name: SHARE_OPTIONS.password,
				description: 'Save the share password so people here can start it without typing it',
				max_length: 128,
			},
			{
				type: ApplicationCommandOptionType.Boolean,
				name: SHARE_OPTIONS.panel,
				description: 'Pin as this channel\'s status panel (Nodecraft must be added to this server)',
			},
		],
	},
];

export const liteMessageCommands = [START_MESSAGE_COMMAND];
