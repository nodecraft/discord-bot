import type { WakeWatcher } from './features/lite/wake-watcher.ts';

export interface Env {
	// nodepanel Postgres, schemas from @nodecraft/db
	HYPERDRIVE: Hyperdrive;
	// controller OAuth tokens, shared across requests the same way billing does
	DISCORD_BOT_SETTINGS: KVNamespace;
	WAKE_WATCHER: DurableObjectNamespace<WakeWatcher>;
	// per Discord user and per Discord server, across every command and click
	USER_RATE_LIMIT: RateLimit;
	GUILD_RATE_LIMIT: RateLimit;
	// Analytics Engine: requests and background work for engineering, feature usage for product (see src/lib/analytics.ts)
	TECHNICAL_ANALYTICS: AnalyticsEngineDataset;
	PRODUCT_ANALYTICS: AnalyticsEngineDataset;

	DISCORD_APPLICATION_ID: string;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_BOT_TOKEN: string;
	// where every non-bot path on the hostname redirects, preserving discord.nodecraft.com's old behaviour
	DISCORD_INVITE_URL: string;

	// set to "off" to stop every wake poll and panel check at its next alarm
	LITE_BACKGROUND_UPDATES: string;

	NODECRAFT_API_URL: string;
	NODECRAFT_OAUTH_SCOPE: string;
	NODECRAFT_CLIENT_ID: string;
	NODECRAFT_CLIENT_SECRET: string;

	// base64 AES-256 key for secrets we store, such as remembered share passwords
	CARD_ENCRYPTION_KEY: string;
}
