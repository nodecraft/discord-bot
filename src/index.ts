import { Hono } from 'hono';

import { handleInteraction } from './discord/router.ts';
import { verifyDiscordRequest } from './discord/verify.ts';

import type { Env } from './env.ts';
import type { APIInteraction } from 'discord-api-types/v10';

export { WakeWatcher } from './features/lite/wake-watcher.ts';

const app = new Hono<{ Bindings: Env; }>();

app.get('/health', context => context.text('ok'));

// a stable, branded install link for nodepanel and docs; Discord's own page then offers "My Apps" or "Server"
app.get('/install', context => context.redirect(`https://discord.com/oauth2/authorize?client_id=${context.env.DISCORD_APPLICATION_ID}`, 302));

app.post('/interactions', async (context) => {
	// the signature covers the raw bytes, so read text before parsing
	const body = await context.req.text();
	const valid = await verifyDiscordRequest(
		context.req.header('x-signature-ed25519'),
		context.req.header('x-signature-timestamp'),
		body,
		context.env.DISCORD_PUBLIC_KEY,
	);
	if (!valid) {
		return context.text('Bad request signature', 401);
	}
	const interaction = JSON.parse(body) as APIInteraction;
	const response = await handleInteraction(interaction, {
		env: context.env,
		waitUntil: promise => context.executionCtx.waitUntil(promise),
	});
	return context.json(response);
});

// discord.nodecraft.com has always redirected to the community server, and links to it are published (nodepanel support)
app.notFound(context => context.redirect(context.env.DISCORD_INVITE_URL, 301));

export default app;
