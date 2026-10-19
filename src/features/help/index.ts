import { HELP_SUBCOMMAND } from './commands.ts';
import { ephemeralMessage } from '../../discord/responses.ts';

import type { Feature } from '../../discord/types.ts';

const HELP_TEXT = [
	'## Nodecraft in Discord',
	'**Share a Lite server**',
	'1. Copy your server\'s share link from its Lite settings in Nodecraft.',
	'2. Run `/nodecraft share link:<your share link>` in any channel. Anyone who can see the card can wake the server.',
	'- Add `panel:True` to pin a panel that keeps itself up to date. Nodecraft has to be added to this Discord server for panels.',
	'- Add `password:<your share password>` to save it with the card, so friends don\'t have to type it.',
	'',
	'**Wake from a message**',
	'Right-click a message with a share link, then choose **Apps > Wake Lite server**.',
	'',
	'Add Nodecraft to your account or a Discord server: https://discord.nodecraft.com/install',
].join('\n');

// Not tied to one product area, so future features can add their own sections here
export const help: Feature = {
	name: 'help',
	subcommands: {
		[HELP_SUBCOMMAND]: () => ephemeralMessage(HELP_TEXT),
	},
};
