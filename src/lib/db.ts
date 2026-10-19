import { discordBotLiteCards } from '@nodecraft/db/nodepanel/schemas';
import { instrumentDrizzle } from 'cloudflare-drizzle-tracing';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { Env } from '../env.ts';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

const schema = { discordBotLiteCards };

export type Database = PostgresJsDatabase<typeof schema>;

// Drizzle sends every query through `unsafe()`, which postgres.js forces onto the unnamed prepared statement.
// Hyperdrive pools in transaction mode, so named statements stop one query binding another's params (see rules-engine-worker).
function useNamedStatements(connection: postgres.Sql): postgres.Sql {
	return new Proxy(connection, {
		get(target, prop, receiver) {
			if (prop !== 'unsafe') {
				return Reflect.get(target, prop, receiver);
			}
			return (query: string, params?: postgres.ParameterOrJSON<never>[], options?: postgres.UnsafeQueryOptions) => target.unsafe(query, params, { ...options, prepare: true });
		},
	});
}

// Opens a connection per unit of work and always closes it; Workers can't share sockets across requests
export async function withDB<T>(env: Env, work: (db: Database) => Promise<T>): Promise<T> {
	const connection = postgres(env.HYPERDRIVE.connectionString, {
		// Workers allow 6 outbound connections per request, so leave room for Discord and controller calls
		max: 3,
		connect_timeout: 60,
		prepare: true,
	});
	const db = instrumentDrizzle(drizzle(useNamedStatements(connection), { schema }));
	try {
		return await work(db);
	} finally {
		await connection.end().catch(() => {});
	}
}
