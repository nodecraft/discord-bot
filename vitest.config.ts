import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: './wrangler.toml',
			},
			miniflare: {
				// test-only values; the public key pairs with the private key in test/helpers.ts
				bindings: {
					DISCORD_APPLICATION_ID: '100000000000000000',
					DISCORD_PUBLIC_KEY: '64c7d4a866784ddad39874f4efb6a4d32456b646d67c4b14b23fcd30d83b8b43',
					DISCORD_BOT_TOKEN: 'test-bot-token',
					NODECRAFT_CLIENT_ID: 'test-client',
					NODECRAFT_CLIENT_SECRET: 'test-secret',
					CARD_ENCRYPTION_KEY: 'xObs8kTzjYwKqXzHc2naQ/q992wDGrnJtUlndSlRl4Q=',
				},
			},
		}),
	],
	test: {
		deps: {
			// discord-api-types ships CommonJS behind an ESM wrapper, which workerd can't load without pre-bundling
			optimizer: {
				ssr: {
					enabled: true,
					include: ['discord-api-types/v10'],
				},
			},
		},
	},
});
