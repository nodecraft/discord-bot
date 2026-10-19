import { discordBotLiteCards } from '@nodecraft/db/nodepanel/schemas';
import {
	and,
	count,
	eq,
	inArray,
	ne,
} from 'drizzle-orm';

import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret } from '../../lib/crypto.ts';

import type { Env } from '../../env.ts';
import type { Database } from '../../lib/db.ts';

export type LiteCard = typeof discordBotLiteCards.$inferSelect;
export type PasswordMode = LiteCard['password_mode'];

export interface NewCard {
	shareId: string;
	guildId: string | null;
	channelId: string;
	createdBy: string;
	isPanel: boolean;
	passwordMode: PasswordMode;
	password?: string;
}

export async function createCard(db: Database, env: Env, card: NewCard): Promise<LiteCard> {
	// the id is chosen up front because it's bound into the password ciphertext
	const id = crypto.randomUUID();
	let passwordCt: string | null = null;
	let keyVersion: number | null = null;
	if (card.passwordMode === 'remember' && card.password) {
		passwordCt = await encryptSecret(env.CARD_ENCRYPTION_KEY, card.password, id);
		keyVersion = CURRENT_KEY_VERSION;
	}
	const [row] = await db.insert(discordBotLiteCards).values({
		id,
		share_id: card.shareId,
		guild_id: card.guildId,
		channel_id: card.channelId,
		created_by: card.createdBy,
		is_panel: card.isPanel,
		password_mode: card.passwordMode,
		password_ct: passwordCt,
		key_version: keyVersion,
	}).returning();
	if (!row) {
		throw new Error('Inserting a Lite card returned no row');
	}
	return row;
}

export async function getCard(db: Database, id: string): Promise<LiteCard | null> {
	const [row] = await db.select().from(discordBotLiteCards).where(eq(discordBotLiteCards.id, id))
		.limit(1);
	return row ?? null;
}

export async function cardPassword(env: Env, card: LiteCard): Promise<string | undefined> {
	if (card.password_mode !== 'remember' || !card.password_ct) {
		return undefined;
	}
	return decryptSecret(env.CARD_ENCRYPTION_KEY, card.password_ct, card.id);
}

export async function switchToAsk(db: Database, id: string): Promise<void> {
	await db.update(discordBotLiteCards)
		.set({ password_mode: 'ask', password_ct: null, key_version: null })
		.where(eq(discordBotLiteCards.id, id));
}

export async function setMessageId(db: Database, id: string, messageId: string): Promise<void> {
	await db.update(discordBotLiteCards).set({ message_id: messageId }).where(eq(discordBotLiteCards.id, id));
}

// returns the panel being replaced, so its message can be cleaned up
export async function takeExistingPanel(db: Database, channelId: string): Promise<LiteCard | null> {
	const [existing] = await db.update(discordBotLiteCards)
		.set({ is_panel: false })
		.where(and(eq(discordBotLiteCards.channel_id, channelId), eq(discordBotLiteCards.is_panel, true)))
		.returning();
	return existing ?? null;
}

// panels other than this channel's, which a new panel here would replace rather than add to
export async function countOtherPanels(db: Database, { guildId, shareId, channelId }: { guildId: string; shareId: string; channelId: string; }) {
	const otherChannel = and(eq(discordBotLiteCards.is_panel, true), ne(discordBotLiteCards.channel_id, channelId));
	const [inGuild] = await db.select({ value: count() }).from(discordBotLiteCards)
		.where(and(otherChannel, eq(discordBotLiteCards.guild_id, guildId)));
	const [forShare] = await db.select({ value: count() }).from(discordBotLiteCards)
		.where(and(otherChannel, eq(discordBotLiteCards.share_id, shareId)));
	return { guild: inGuild?.value ?? 0, share: forShare?.value ?? 0 };
}

// a panel whose message is gone stops counting toward the panel caps
export async function retirePanels(db: Database, ids: string[]): Promise<void> {
	if (ids.length === 0) {
		return;
	}
	await db.update(discordBotLiteCards).set({ is_panel: false }).where(inArray(discordBotLiteCards.id, ids));
}
