# discord-bot

Nodecraft's Discord app, running on Cloudflare Workers as an HTTP interactions endpoint (no gateway connection).

Today it covers Nodecraft Lite share links: anyone in a channel can see a Lite server's status and wake it from a card, with the owner's share password and Share Lock still in charge. It's built so more product areas can be added as features.

## How it fits together

- `POST /interactions` verifies Discord's Ed25519 signature, then routes the interaction to a feature.
- Every other path on `discord.nodecraft.com` 301s to `DISCORD_INVITE_URL` (the community server), which is what the hostname did before the bot took it over.
- Slow work (controller calls, message edits) runs after a deferred response, inside `waitUntil`.
- controller is called with the bot's own OAuth client (client credentials) through `@nodecraft/workers-helpers`. Tokens are shared through the `DISCORD_BOT_SETTINGS` KV namespace, the same way billing does it.
- Card data lives in nodepanel's Postgres through Hyperdrive. The schema is `discord_bot_lite_cards` in [`@nodecraft/db`](https://github.com/nodecraft/db).
- `WakeWatcher` is a Durable Object per share ID. It collapses parallel wakes into one controller call and polls status every 10 seconds, editing every card until the server is online or 6 minutes pass.
- Analytics go to two Workers Analytics Engine datasets, charted in Grafana (`grafana-sync`, Workers folder). `DISCORD_BOT_TECHNICAL` has every request, background task and `WakeWatcher` alarm with timings. `DISCORD_BOT_PRODUCT` has feature events such as shares and wakes. Columns are positional, so only append fields in `src/lib/analytics.ts`.

## Adding a feature

1. Create `src/features/<name>/` with a `Feature` (see `src/discord/types.ts`). Its `name` prefixes every `custom_id` it owns, as `<name>:<action>:<arg>`.
2. Put command definitions in their own file with no Worker runtime imports, and add them to `src/commands.ts`. Commands live under the single `/nodecraft` command as subcommands, or subcommand groups routed as `group.subcommand`.
3. Register the feature in `src/features/index.ts`.

## Development

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in the values
node --run db:local              # Postgres in Docker, with this bot's tables from @nodecraft/db
node --run dev
```

`node --run dev` passes `.dev.vars` to wrangler with `--env-file`, so `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in that file picks the database. The example value matches `node --run db:local`; change it to use another database, such as a Neon branch. `node --run db:local:stop` stops the container and keeps its data.

Register commands after changing them (set `DISCORD_DEV_GUILD_ID` to target one server, which updates instantly):

```sh
node --run commands:register
```

## Checks

```sh
node --run lint
node --run check-types
node --run test
```

## Deploying

- There are two environments: local dev (`node --run dev`) and production. Every push to `main` deploys production, using the `CF_API_TOKEN` and `NPM_TOKEN` repository secrets.
- Each deploy also registers the slash commands from `src/commands.ts` with Discord, using `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN` secrets on the GitHub `production` environment.
- Worker secrets are set with `wrangler secret put <NAME> --env production`: `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `NODECRAFT_CLIENT_ID`, `NODECRAFT_CLIENT_SECRET`, `CARD_ENCRYPTION_KEY`.
- Database migrations ship from the `db` repo, not here.
- controller must list the bot's OAuth client id in `instances.jitTrustedRateKeyClients`, so share password attempts are rate limited per Discord user instead of per Cloudflare IP.
