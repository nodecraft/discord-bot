import { defineConfig } from 'drizzle-kit';

// Local dev only: creates this bot's tables from the published @nodecraft/db schema, which stays the source of truth
export default defineConfig({
	dialect: 'postgresql',
	schema: './node_modules/@nodecraft/db/dist/databases/nodepanel/schemas/discord_bot_*.js',
	dbCredentials: {
		// keep in sync with the HYPERDRIVE localConnectionString in wrangler.toml
		url: 'postgres://postgres:postgres@localhost:5432/nodepanel',
	},
});
