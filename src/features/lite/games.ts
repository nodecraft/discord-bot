import { controllerData } from '../../nodecraft/controller.ts';

import type { Env } from '../../env.ts';
import type { ControllerClient } from '../../nodecraft/controller.ts';

interface StoryblokAsset {
	filename?: string | null;
}

// the parts of controller's CMS game stories (GET /v5/games/list) that cards use
interface CmsGame {
	name: string;
	content?: {
		nodepanelId?: string;
		shortTitle?: string;
		icon?: StoryblokAsset;
		banner?: StoryblokAsset;
	};
}

export interface GameArt {
	name: string;
	icon: string | null;
	banner: string | null;
}

const CACHE_KEY = 'lite:games:v1';
// the game list changes rarely and its payload is large, so one fetch serves every card for hours
const CACHE_TTL_SECONDS = 6 * 60 * 60;

// Mirrors nodepanel's storyblok imageUrl: served from cms-a.nodecraft.com through Storyblok's resize service
function imageUrl(asset: StoryblokAsset | undefined, width: number, height: number): string | null {
	if (!asset?.filename) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(asset.filename);
	} catch {
		return null;
	}
	// Discord can't render SVG, and Storyblok's image service doesn't rasterise it
	if (url.pathname.endsWith('.svg')) {
		return null;
	}
	return `https://cms-a.nodecraft.com${url.pathname}/m/${width}x${height}/smart`;
}

async function loadCatalog(client: ControllerClient): Promise<Record<string, GameArt>> {
	const data = await controllerData<{ games: CmsGame[]; }>(client, '/v5/games/list');
	const catalog: Record<string, GameArt> = {};
	for (const game of data.games) {
		const module = game.content?.nodepanelId;
		if (!module) {
			continue;
		}
		catalog[module] = {
			name: game.content?.shortTitle || game.name,
			icon: imageUrl(game.content?.icon, 256, 256),
			banner: imageUrl(game.content?.banner, 1200, 400),
		};
	}
	return catalog;
}

// Art is decoration, so any failure here renders a plain card rather than an error
export async function gameArt(env: Env, client: ControllerClient, module: string | undefined): Promise<GameArt | null> {
	if (!module) {
		return null;
	}
	try {
		let catalog = await env.DISCORD_BOT_SETTINGS.get<Record<string, GameArt>>(CACHE_KEY, 'json');
		if (!catalog) {
			catalog = await loadCatalog(client);
			await env.DISCORD_BOT_SETTINGS.put(CACHE_KEY, JSON.stringify(catalog), { expirationTtl: CACHE_TTL_SECONDS });
		}
		return catalog[module] ?? null;
	} catch (err) {
		console.error('Lite game art lookup failed', module, err);
		return null;
	}
}
