import { FEATURE } from './cards.ts';
import { SHARE_SUBCOMMAND, WAKE_MESSAGE_COMMAND } from './commands.ts';
import {
	passwordSubmit,
	refreshButton,
	shareCommand,
	wakeButton,
	wakeMessageCommand,
} from './handlers.ts';

import type { Feature } from '../../discord/types.ts';

export const lite: Feature = {
	name: FEATURE,
	subcommands: {
		[SHARE_SUBCOMMAND]: shareCommand,
	},
	messageCommands: {
		[WAKE_MESSAGE_COMMAND]: wakeMessageCommand,
	},
	components: {
		wake: wakeButton,
		refresh: refreshButton,
	},
	modals: {
		password: passwordSubmit,
	},
};
