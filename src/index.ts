import { Hono } from 'hono';
import { matchedRoutes, routePath } from 'hono/route';

import { handleInteraction, interactionAction } from './discord/router.ts';
import { verifyDiscordRequest } from './discord/verify.ts';
import { trackTechnical } from './lib/analytics.ts';

import type { Env } from './env.ts';
import type { APIInteraction } from 'discord-api-types/v10';

export { WakeWatcher } from './features/lite/wake-watcher.ts';

interface Variables {
	interaction?: APIInteraction;
	outcome?: string;
}

const app = new Hono<{ Bindings: Env; Variables: Variables; }>();

app.use(async (context, next) => {
	const startedAt = Date.now();
	await next();
	// only this middleware matching means no route did, and raw unmatched paths would flood the route breakdown
	let name = 'not_found';
	if (matchedRoutes(context).length > 1) {
		name = routePath(context, -1);
	}
	const interaction = context.get('interaction');
	let action: string | undefined;
	if (interaction) {
		action = interactionAction(interaction);
	}
	let outcome = context.get('outcome') ?? 'ok';
	if (context.error) {
		outcome = 'error';
	}
	trackTechnical(context.env, {
		type: 'request',
		name,
		action,
		outcome,
		status: context.res.status,
		durationMs: Date.now() - startedAt,
		request: context.req.raw,
		interaction,
	});
});

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
		context.set('outcome', 'bad_signature');
		return context.text('Bad request signature', 401);
	}
	const interaction = JSON.parse(body) as APIInteraction;
	context.set('interaction', interaction);
	const { response, outcome } = await handleInteraction(interaction, {
		env: context.env,
		waitUntil: promise => context.executionCtx.waitUntil(promise),
	});
	context.set('outcome', outcome);
	return context.json(response);
});

// discord.nodecraft.com has always redirected to the community server, and links to it are published (nodepanel support)
app.notFound(context => context.redirect(context.env.DISCORD_INVITE_URL, 301));

export default app;
