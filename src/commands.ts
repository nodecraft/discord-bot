// Command definitions only, with no Worker runtime imports, so scripts/register-commands.ts can run under Node
import { ApplicationCommandType, ApplicationIntegrationType, InteractionContextType } from 'discord-api-types/v10';

import { helpSubcommands } from './features/help/commands.ts';
import { liteMessageCommands, liteSubcommands } from './features/lite/commands.ts';

import type { RESTPutAPIApplicationCommandsJSONBody } from 'discord-api-types/v10';


export const ROOT_COMMAND = 'nodecraft';

const integrationTypes = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const contexts = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];

export const commands: RESTPutAPIApplicationCommandsJSONBody = [
	{
		name: ROOT_COMMAND,
		description: 'Nodecraft server tools',
		type: ApplicationCommandType.ChatInput,
		integration_types: integrationTypes,
		contexts,
		options: [...liteSubcommands, ...helpSubcommands],
	},
	...liteMessageCommands.map((name) => {
		return {
			name,
			type: ApplicationCommandType.Message as const,
			integration_types: integrationTypes,
			contexts,
		};
	}),
];
