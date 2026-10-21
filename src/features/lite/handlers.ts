import {
	ApplicationCommandOptionType,
	ComponentType,
	InteractionResponseType,
	TextInputStyle,
} from 'discord-api-types/v10';

import { getSharedServer } from './api.ts';
import {
	FEATURE,
	findCardId,
	renderCard,
	renderNotice,
} from './cards.ts';
import { SHARE_OPTIONS } from './commands.ts';
import { UNUSABLE_LINK_CODES, errorMessage } from './errors.ts';
import { gameArt } from './games.ts';
import { findShareIdInMessage, parseShareInput } from './share-link.ts';
import {
	cardPassword,
	countOtherPanels,
	createCard,
	getCard,
	promoteToPanel,
	switchToAsk,
} from './store.ts';
import { deferredMessage, deferredUpdate, ephemeralMessage } from '../../discord/responses.ts';
import {
	DiscordApiError,
	createChannelMessage,
	deleteChannelMessage,
	editOriginalResponse,
} from '../../discord/rest.ts';
import { customId, interactionUserId, isInstalledInGuild } from '../../discord/types.ts';
import { trackEvent, trackTechnical } from '../../lib/analytics.ts';
import { withDB } from '../../lib/db.ts';
import { controller, nodecraftErrorCode } from '../../nodecraft/controller.ts';

import type { SharedServer } from './api.ts';
import type { LiteCard, PasswordMode } from './store.ts';
import type { PanelRef, WakeResult } from './wake-watcher.ts';
import type {
	ComponentHandler,
	InteractionContext,
	MessageCommandHandler,
	ModalHandler,
	SubcommandHandler,
} from '../../discord/types.ts';
import type { Env } from '../../env.ts';
import type {
	APIApplicationCommandInteractionDataBasicOption,
	APIChatInputApplicationCommandInteraction,
	APIInteraction,
	APIInteractionResponse,
	APIModalSubmission,
} from 'discord-api-types/v10';

const PASSWORD_INPUT = 'password';
const CARD_EXPIRED = 'This card is no longer available. Post the share link again with /nodecraft share.';
const NO_LINK_FOUND = 'I couldn\'t find a Lite share link or card in that message.';

function subcommandOptions(interaction: APIChatInputApplicationCommandInteraction): Map<string, APIApplicationCommandInteractionDataBasicOption> {
	const [subcommand] = interaction.data.options ?? [];
	const options = new Map<string, APIApplicationCommandInteractionDataBasicOption>();
	if (subcommand?.type === ApplicationCommandOptionType.Subcommand) {
		for (const option of subcommand.options ?? []) {
			options.set(option.name, option);
		}
	}
	return options;
}

function stringOption(options: Map<string, APIApplicationCommandInteractionDataBasicOption>, name: string): string | undefined {
	const option = options.get(name);
	if (option?.type === ApplicationCommandOptionType.String) {
		return option.value;
	}
	return undefined;
}

function passwordModeFor(server: SharedServer, password: string | undefined): PasswordMode {
	if (!server.jit_share_password_enabled) {
		return 'none';
	}
	if (password) {
		return 'remember';
	}
	return 'ask';
}

// the deferred work is what users wait on, so it's timed separately from the instant reply to Discord
async function backgroundTask(ctx: InteractionContext, task: string, token: string, work: () => Promise<void>): Promise<void> {
	const startedAt = Date.now();
	let outcome = 'ok';
	try {
		await work();
	} catch (err) {
		outcome = 'error';
		console.error('Lite background task failed', err);
		try {
			await editOriginalResponse(ctx.env, token, renderNotice(errorMessage(err), null));
		} catch {
			// nothing left to tell the user with
		}
	}
	trackTechnical(ctx.env, { type: 'task', name: task, outcome, durationMs: Date.now() - startedAt });
}

function runInBackground(ctx: InteractionContext, task: string, token: string, work: () => Promise<void>) {
	ctx.waitUntil(backgroundTask(ctx, task, token, work));
}

// each panel keeps a scheduled status check alive, so they're capped where one server or one popular link could pile them up
const MAX_PANELS_PER_GUILD = 5;
const MAX_PANELS_PER_SHARE = 10;

async function panelLimitMessage(env: Env, guildId: string, shareId: string, channelId: string): Promise<string | null> {
	const panels = await withDB(env, db => countOtherPanels(db, { guildId, shareId, channelId }));
	if (panels.guild >= MAX_PANELS_PER_GUILD) {
		return `This Discord server already has ${MAX_PANELS_PER_GUILD} Lite panels. Delete one, or post this one in a channel that already has a panel to replace it.`;
	}
	if (panels.share >= MAX_PANELS_PER_SHARE) {
		return `This server is already pinned as a panel in ${MAX_PANELS_PER_SHARE} channels. Post a regular card instead by leaving out \`panel\`.`;
	}
	return null;
}

function layoutOf(card: LiteCard) {
	if (card.is_panel) {
		return 'panel';
	}
	return 'card';
}

function watcher(env: Env, shareId: string) {
	return env.WAKE_WATCHER.getByName(shareId);
}

// what the watcher needs to know about a card on each click, including where a panel lives so it can keep editing it
function cardRequest(card: LiteCard, token: string) {
	let panelMessage: PanelRef | undefined;
	if (card.is_panel && card.message_id) {
		panelMessage = { channelId: card.channel_id, messageId: card.message_id };
	}
	return { shareId: card.share_id, cardId: card.id, token, panel: card.is_panel, panelMessage };
}

type WakeSource = 'button' | 'password' | 'right_click_card' | 'right_click_link';

type TokenInteraction = APIInteraction & { token: string; };

function trackWake(ctx: InteractionContext, interaction: TokenInteraction, card: LiteCard, source: WakeSource, result: WakeResult) {
	let outcome: string;
	let module: string | undefined;
	if (result.ok) {
		outcome = result.outcome;
		module = result.module;
	} else {
		outcome = result.code;
		if (result.passwordError) {
			outcome = 'wrong_password';
		}
		module = result.server?.module;
	}
	trackEvent(ctx.env, {
		event: 'wake',
		outcome,
		shareId: card.share_id,
		module,
		source,
		layout: layoutOf(card),
		passwordMode: card.password_mode,
	}, interaction);
}

async function runWake(ctx: InteractionContext, interaction: TokenInteraction, card: LiteCard, source: WakeSource, password: string | undefined): Promise<void> {
	const token = interaction.token;
	const result = await watcher(ctx.env, card.share_id).wake({ ...cardRequest(card, token), userId: interactionUserId(interaction), password });
	trackWake(ctx, interaction, card, source, result);
	if (result.ok) {
		return;
	}

	let note = result.message;
	if (result.passwordError) {
		if (card.password_mode === 'none') {
			await withDB(ctx.env, db => switchToAsk(db, card.id));
			note = 'This server now needs the share password. Press Wake to enter it.';
		} else if (card.password_mode === 'remember') {
			// controller reports rate limits as a wrong password, so keep the saved one rather than discard it
			note = 'The saved password didn\'t work. If this keeps happening, post the share link again.';
		} else {
			note = 'Wrong password, or too many tries. Wait a few minutes and try again.';
		}
	}

	if (result.server && !UNUSABLE_LINK_CODES.has(result.code)) {
		await editOriginalResponse(ctx.env, token, renderCard(result.server, { cardId: card.id, note, layout: layoutOf(card), game: result.game }));
	} else {
		await editOriginalResponse(ctx.env, token, renderNotice(note, card.id));
	}
}

async function postShareCard(
	ctx: InteractionContext,
	interaction: APIChatInputApplicationCommandInteraction,
	shareId: string,
	password: string | undefined,
	isPanel: boolean,
): Promise<void> {
	let layout: 'card' | 'panel' = 'card';
	if (isPanel) {
		layout = 'panel';
	}
	const track = (outcome: string, server?: SharedServer) => {
		let passwordMode: PasswordMode | undefined;
		if (server) {
			passwordMode = passwordModeFor(server, password);
		}
		trackEvent(ctx.env, { event: 'share', outcome, shareId, module: server?.module, source: 'command', layout, passwordMode }, interaction);
	};

	const client = await controller(ctx.env, ctx.waitUntil);
	let server: SharedServer;
	try {
		server = await getSharedServer(client, shareId);
	} catch (err) {
		track(nodecraftErrorCode(err) ?? 'error');
		await editOriginalResponse(ctx.env, interaction.token, renderNotice(errorMessage(err), null));
		return;
	}

	const channelId = interaction.channel.id;
	if (isPanel) {
		const limitMessage = await panelLimitMessage(ctx.env, interaction.guild_id ?? '', shareId, channelId);
		if (limitMessage) {
			track('panel_limit', server);
			await editOriginalResponse(ctx.env, interaction.token, { content: limitMessage });
			return;
		}
	}
	const card = await withDB(ctx.env, db => createCard(db, ctx.env, {
		shareId,
		guildId: interaction.guild_id ?? null,
		channelId,
		createdBy: interactionUserId(interaction),
		passwordMode: passwordModeFor(server, password),
		password,
	}));
	const game = await gameArt(ctx.env, client, server.module);
	const message = renderCard(server, { cardId: card.id, layout, game });

	if (!isPanel) {
		await editOriginalResponse(ctx.env, interaction.token, message);
		track('posted', server);
		return;
	}
	let messageId: string;
	try {
		const posted = await createChannelMessage(ctx.env, channelId, message);
		messageId = posted.id;
	} catch (err) {
		if (err instanceof DiscordApiError && err.status === 403) {
			track('no_permission', server);
			await editOriginalResponse(ctx.env, interaction.token, { content: 'I can\'t post in this channel. Check that Nodecraft can view and send messages here.' });
			return;
		}
		throw err;
	}
	track('posted', server);
	// the card only becomes a panel once its message exists, so a failed post never counts toward the caps or replaces the existing one
	const previousPanel = await withDB(ctx.env, db => promoteToPanel(db, { id: card.id, channelId, messageId }));
	await watcher(ctx.env, shareId).watchPanel({ cardId: card.id, message: { channelId, messageId }, server, game });
	if (previousPanel) {
		await watcher(ctx.env, previousPanel.share_id).unwatchPanel(previousPanel.id).catch(() => {});
		if (previousPanel.message_id) {
			await deleteChannelMessage(ctx.env, channelId, previousPanel.message_id).catch(() => {});
		}
	}
	await editOriginalResponse(ctx.env, interaction.token, { content: 'Panel posted. It replaces any earlier panel in this channel.' });
}

export const shareCommand: SubcommandHandler = (interaction, ctx) => {
	const options = subcommandOptions(interaction);
	const shareId = parseShareInput(stringOption(options, SHARE_OPTIONS.link) ?? '');
	if (!shareId) {
		trackEvent(ctx.env, { event: 'share', outcome: 'invalid_link', source: 'command' }, interaction);
		return ephemeralMessage('That isn\'t a Lite share link. It looks like https://app.nodecraft.com/shared/...');
	}
	const panelOption = options.get(SHARE_OPTIONS.panel);
	const isPanel = panelOption?.type === ApplicationCommandOptionType.Boolean && panelOption.value;
	if (isPanel && !isInstalledInGuild(interaction)) {
		trackEvent(ctx.env, { event: 'share', outcome: 'needs_install', shareId, source: 'command', layout: 'panel' }, interaction);
		return ephemeralMessage('To pin a panel, add Nodecraft to this server first. You can still post a regular card without `panel`.');
	}
	const password = stringOption(options, SHARE_OPTIONS.password);
	runInBackground(ctx, 'share', interaction.token, () => postShareCard(ctx, interaction, shareId, password, isPanel));
	// panels are posted separately, so the command's own reply stays private
	return deferredMessage(isPanel);
};

function passwordModal(cardId: string): APIInteractionResponse {
	return {
		type: InteractionResponseType.Modal,
		data: {
			custom_id: customId(FEATURE, 'password', cardId),
			title: 'Share password',
			components: [{
				type: ComponentType.Label,
				label: 'Share password',
				description: 'Ask the server owner if you don\'t know it.',
				component: {
					type: ComponentType.TextInput,
					custom_id: PASSWORD_INPUT,
					style: TextInputStyle.Short,
					required: true,
					max_length: 128,
				},
			}],
		},
	};
}

// shared by the Wake button and right-clicking a card, which differ only in whether the reply replaces the card or follows it
async function wakeCard(interaction: TokenInteraction, ctx: InteractionContext, cardId: string, source: WakeSource, deferred: APIInteractionResponse): Promise<APIInteractionResponse> {
	const card = await withDB(ctx.env, db => getCard(db, cardId));
	if (!card) {
		return ephemeralMessage(CARD_EXPIRED);
	}
	if (card.password_mode === 'ask') {
		trackEvent(ctx.env, { event: 'password_prompt', shareId: card.share_id, source, layout: layoutOf(card), passwordMode: card.password_mode }, interaction);
		return passwordModal(card.id);
	}
	runInBackground(ctx, 'wake', interaction.token, async () => {
		const password = await cardPassword(ctx.env, card);
		await runWake(ctx, interaction, card, source, password);
	});
	return deferred;
}

export const wakeMessageCommand: MessageCommandHandler = (interaction, ctx) => {
	const target = interaction.data.resolved.messages[interaction.data.target_id];
	if (!target) {
		return ephemeralMessage(NO_LINK_FOUND);
	}
	// only our own messages, so another bot can't borrow a card id (and its saved password) by copying its buttons
	if (target.author.id === ctx.env.DISCORD_APPLICATION_ID) {
		const cardId = findCardId(target.components ?? []);
		if (cardId) {
			return wakeCard(interaction, ctx, cardId, 'right_click_card', deferredMessage(false));
		}
	}
	const shareId = findShareIdInMessage(target);
	if (!shareId) {
		trackEvent(ctx.env, { event: 'share', outcome: 'invalid_link', source: 'right_click_link' }, interaction);
		return ephemeralMessage(NO_LINK_FOUND);
	}
	runInBackground(ctx, 'wake_link', interaction.token, async () => {
		const client = await controller(ctx.env, ctx.waitUntil);
		let server: SharedServer;
		try {
			server = await getSharedServer(client, shareId);
		} catch (err) {
			trackEvent(ctx.env, { event: 'share', outcome: nodecraftErrorCode(err) ?? 'error', shareId, source: 'right_click_link', layout: 'card' }, interaction);
			await editOriginalResponse(ctx.env, interaction.token, renderNotice(errorMessage(err), null));
			return;
		}
		const card = await withDB(ctx.env, db => createCard(db, ctx.env, {
			shareId,
			guildId: interaction.guild_id ?? null,
			channelId: interaction.channel.id,
			createdBy: interactionUserId(interaction),
			passwordMode: passwordModeFor(server, undefined),
		}));
		trackEvent(ctx.env, {
			event: 'share',
			outcome: 'posted',
			shareId,
			module: server.module,
			source: 'right_click_link',
			layout: 'card',
			passwordMode: card.password_mode,
		}, interaction);
		if (card.password_mode === 'ask') {
			await editOriginalResponse(ctx.env, interaction.token, renderCard(server, {
				cardId: card.id,
				game: await gameArt(ctx.env, client, server.module),
				note: 'Press Wake and enter the share password.',
			}));
			return;
		}
		await runWake(ctx, interaction, card, 'right_click_link', undefined);
	});
	return deferredMessage(false);
};

function modalValue(data: APIModalSubmission, inputId: string): string | undefined {
	// modals arrive with inputs wrapped in Labels, or in action rows from older clients
	const inputs = data.components.flatMap((row) => {
		if (row.type === ComponentType.Label) {
			return [row.component];
		}
		if (row.type === ComponentType.ActionRow) {
			return row.components;
		}
		return [];
	});
	const input = inputs.find(component => component.custom_id === inputId);
	if (input?.type === ComponentType.TextInput) {
		return input.value;
	}
	return undefined;
}

export const wakeButton: ComponentHandler = (interaction, ctx, cardId) => wakeCard(interaction, ctx, cardId, 'button', deferredUpdate());

export const passwordSubmit: ModalHandler = async (interaction, ctx, cardId) => {
	const card = await withDB(ctx.env, db => getCard(db, cardId));
	if (!card) {
		return ephemeralMessage(CARD_EXPIRED);
	}
	const password = modalValue(interaction.data, PASSWORD_INPUT);
	runInBackground(ctx, 'wake', interaction.token, () => runWake(ctx, interaction, card, 'password', password));
	// a modal opened from a right-click has no message to update, so it gets a new reply instead
	if (interaction.message) {
		return deferredUpdate();
	}
	return deferredMessage(false);
};

export const refreshButton: ComponentHandler = async (interaction, ctx, cardId) => {
	const card = await withDB(ctx.env, db => getCard(db, cardId));
	if (!card) {
		return ephemeralMessage(CARD_EXPIRED);
	}
	trackEvent(ctx.env, { event: 'refresh', shareId: card.share_id, layout: layoutOf(card), passwordMode: card.password_mode }, interaction);
	runInBackground(ctx, 'refresh', interaction.token, () => watcher(ctx.env, card.share_id).refresh(cardRequest(card, interaction.token)));
	return deferredUpdate();
};
