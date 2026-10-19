import { ApplicationCommandOptionType } from 'discord-api-types/v10';

import type { APIApplicationCommandSubcommandOption } from 'discord-api-types/v10';

export const HELP_SUBCOMMAND = 'help';

export const helpSubcommands: APIApplicationCommandSubcommandOption[] = [
	{
		type: ApplicationCommandOptionType.Subcommand,
		name: HELP_SUBCOMMAND,
		description: 'How to use Nodecraft in Discord',
	},
];
