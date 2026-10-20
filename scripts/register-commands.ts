// Usage: node --run commands:register (reads DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN from .dev.vars locally, or the environment in CI)
// Set DISCORD_DEV_GUILD_ID to register to one server instead, which updates instantly while developing
import { commands } from '../src/commands.ts';

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
if (!applicationId || !botToken) {
	throw new Error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required');
}

const guildId = process.env.DISCORD_DEV_GUILD_ID;
let path = `/applications/${applicationId}/commands`;
let target = 'globally';
if (guildId) {
	path = `/applications/${applicationId}/guilds/${guildId}/commands`;
	target = `to guild ${guildId}`;
}

const response = await fetch(`https://discord.com/api/v10${path}`, {
	method: 'PUT',
	headers: {
		'authorization': `Bot ${botToken}`,
		'content-type': 'application/json',
	},
	body: JSON.stringify(commands),
	// runs in the deploy job, which shouldn't sit on a stuck request until its 15 minute timeout
	signal: AbortSignal.timeout(30000),
});

if (!response.ok) {
	throw new Error(`Registering commands failed with ${response.status}: ${await response.text()}`);
}

const registered = await response.json() as { name: string; }[];
console.log(`Registered ${registered.length} commands ${target}: ${registered.map(command => command.name).join(', ')}`);
