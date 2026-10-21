import { DurableObject } from 'cloudflare:workers';

import { getSharedServer, startSharedServer } from './api.ts';
import { renderCard, renderNotice } from './cards.ts';
import { errorMessage, isPasswordError, isUnusableLink } from './errors.ts';
import { gameArt } from './games.ts';
import { describeServer, isServerUp, nextPanelCheck } from './status.ts';
import { retirePanels } from './store.ts';
import {
	DiscordApiError,
	createFollowup,
	editChannelMessage,
	editOriginalResponse,
} from '../../discord/rest.ts';
import { trackEvent, trackTechnical } from '../../lib/analytics.ts';
import { withDB } from '../../lib/db.ts';
import { controller, nodecraftErrorCode } from '../../nodecraft/controller.ts';

import type { SharedServer } from './api.ts';
import type { CardMessage, CardOptions } from './cards.ts';
import type { GameArt } from './games.ts';
import type { Env } from '../../env.ts';
import type { ControllerClient } from '../../nodecraft/controller.ts';

type Layout = NonNullable<CardOptions['layout']>;

const POLL_INTERVAL_MS = 10000;
// matches nodepanel's wake timeout (dashboard.store.ts)
const WAKE_TIMEOUT_MS = 6 * 60000;
// interaction tokens last 15 minutes; stop using them a little early
const TOKEN_LIFETIME_MS = 14 * 60000;
// Discord has no client-side button cooldown, so refreshes inside this window reuse the last status instead of calling controller
const REFRESH_COOLDOWN_MS = 15000;
const PANEL_RETRY_MS = 5 * 60000;
// wakes are deduplicated, but one share being re-woken all day would keep a watcher polling non-stop
const WAKE_BUDGET = 6;
const WAKE_BUDGET_WINDOW_MS = 60 * 60000;
// long enough that shares in regular use never churn, so only abandoned ones pay for the delete
const IDLE_CLEANUP_MS = 30 * 24 * 60 * 60000;

interface Target {
	token: string;
	addedAt: number;
	panel: boolean;
}

export interface PanelRef {
	channelId: string;
	messageId: string;
}

interface WakeState {
	shareId: string;
	startedAt: number;
	progress: 'starting' | 'waking';
	// once controller reports progress, falling back to stored means the wake failed
	sawProgress: boolean;
	server: SharedServer;
	game: GameArt | null;
	updatedAt: number;
	// keyed by card id, so several clicks on one message edit it once
	targets: Record<string, Target>;
	// Discord user id to their latest token, for the "online" ping
	wakers: Record<string, string>;
}

interface Snapshot {
	server: SharedServer;
	game: GameArt | null;
	at: number;
}

interface CardRequest {
	shareId: string;
	cardId: string;
	token: string;
	panel: boolean;
	// sent with panel clicks, so a panel whose registration was lost starts updating again
	panelMessage?: PanelRef;
}

export interface WakeRequest extends CardRequest {
	userId: string;
	password?: string;
}

export type RefreshRequest = CardRequest;

export interface WatchPanelRequest {
	cardId: string;
	message: PanelRef;
	server: SharedServer;
	game: GameArt | null;
}

// joined: a wake was already running; no_action: the server didn't need waking; over_budget: woken too often this hour
export type WakeOutcome = 'joined' | 'no_action' | 'over_budget' | 'started';

export type WakeResult =
	| { ok: true; outcome: WakeOutcome; module?: string; }
	| { ok: false; code: string; message: string; passwordError: boolean; server: SharedServer | null; game: GameArt | null; };

type AlarmJob = 'cleanup' | 'panel_check' | 'paused' | 'wake_poll';

function failure(err: unknown, server: SharedServer | null, game: GameArt | null): WakeResult {
	const code = nodecraftErrorCode(err);
	if (!code) {
		console.error('Lite wake failed', err);
	}
	return { ok: false, code: code ?? 'unknown', message: errorMessage(err), passwordError: isPasswordError(err), server, game };
}

function layoutFor(target: Target): Layout {
	if (target.panel) {
		return 'panel';
	}
	return 'card';
}

// One instance per share ID: it collapses parallel wakes into one controller call, and keeps every card and panel updated
export class WakeWatcher extends DurableObject<Env> {
	// input gates only hold during storage calls, so a click landing while a poll awaits Discord would otherwise lose its target
	private queue: Promise<unknown> = Promise.resolve();

	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.queue.then(work);
		this.queue = run.catch(() => {});
		return run;
	}

	// built per call, not kept on the instance, so token refreshes always go through KV like the Worker's
	private client() {
		return controller(this.env, promise => this.ctx.waitUntil(promise));
	}

	private async loadWake(): Promise<WakeState | undefined> {
		const state = await this.ctx.storage.get<WakeState>('wake');
		if (state && Date.now() - state.startedAt < WAKE_TIMEOUT_MS) {
			return state;
		}
		return undefined;
	}

	private async panels(): Promise<Record<string, PanelRef>> {
		return await this.ctx.storage.get<Record<string, PanelRef>>('panels') ?? {};
	}

	private async remember(request: CardRequest): Promise<void> {
		if (request.panel && request.panelMessage) {
			const panels = await this.panels();
			panels[request.cardId] = request.panelMessage;
			await this.ctx.storage.put('panels', panels);
		}
		// failed wakes and refreshes still write storage, so make sure some alarm will come back to clean it up
		if (await this.ctx.storage.getAlarm() === null) {
			await this.scheduleCleanup();
		}
	}

	// storage is billed until it's deleted, and most shares are clicked once and never again
	private async scheduleCleanup(): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + IDLE_CLEANUP_MS);
	}

	private async cleanUp(): Promise<void> {
		const wakeLog = await this.ctx.storage.get<number[]>('wakeLog') ?? [];
		const lastWake = wakeLog.at(-1) ?? 0;
		// deleting the log early would hand back the wake budget
		if (Date.now() - lastWake < WAKE_BUDGET_WINDOW_MS) {
			await this.ctx.storage.setAlarm(lastWake + WAKE_BUDGET_WINDOW_MS);
			return;
		}
		await this.ctx.storage.deleteAll();
	}

	// fetches status and art together, and remembers them so refreshes can share one controller call
	private async fetchSnapshot(client: ControllerClient, shareId: string): Promise<Snapshot> {
		const server = await getSharedServer(client, shareId);
		const snapshot = { server, game: await gameArt(this.env, client, server.module), at: Date.now() };
		await this.ctx.storage.put('snapshot', snapshot);
		return snapshot;
	}

	private async edit(cardId: string, target: Target, card: CardMessage): Promise<boolean> {
		if (Date.now() - target.addedAt > TOKEN_LIFETIME_MS) {
			return false;
		}
		try {
			await editOriginalResponse(this.env, target.token, card);
			return true;
		} catch (err) {
			// a deleted message or expired token just drops that card from the watch
			if (!(err instanceof DiscordApiError && err.status === 404)) {
				console.error('Failed to update Lite card', cardId, err);
			}
			return false;
		}
	}

	// edits every registered panel with the bot token, dropping panels whose message was deleted
	private async renderPanels(render: (cardId: string) => CardMessage): Promise<Set<string>> {
		const panels = await this.panels();
		const entries = Object.entries(panels);
		const results = await Promise.all(entries.map(async ([cardId, ref]) => {
			try {
				await editChannelMessage(this.env, ref.channelId, ref.messageId, render(cardId));
				return true;
			} catch (err) {
				if (err instanceof DiscordApiError && (err.status === 404 || err.status === 403)) {
					return false;
				}
				console.error('Failed to update Lite panel', cardId, err);
				return true;
			}
		}));
		const gone: string[] = [];
		for (const [index, [cardId]] of entries.entries()) {
			if (results[index]) {
				continue;
			}
			delete panels[cardId];
			gone.push(cardId);
		}
		if (gone.length > 0) {
			await this.ctx.storage.put('panels', panels);
			await withDB(this.env, db => retirePanels(db, gone)).catch((err: unknown) => {
				console.error('Failed to retire deleted Lite panels', gone, err);
			});
		}
		return new Set(Object.keys(panels));
	}

	private async renderAll(state: WakeState, render: (cardId: string, layout: Layout) => CardMessage): Promise<void> {
		const panelIds = await this.renderPanels(cardId => render(cardId, 'panel'));
		const entries = Object.entries(state.targets).filter(([cardId]) => !panelIds.has(cardId));
		const results = await Promise.all(entries.map(([cardId, target]) => this.edit(cardId, target, render(cardId, layoutFor(target)))));
		for (const [index, [cardId]] of entries.entries()) {
			if (!results[index]) {
				delete state.targets[cardId];
			}
		}
	}

	private progressCard(state: WakeState, cardId: string, layout: Layout, note?: string): CardMessage {
		return renderCard(state.server, {
			cardId,
			layout,
			game: state.game,
			note,
			progress: { state: state.progress, since: state.startedAt },
			updatedAt: state.updatedAt,
		});
	}

	private restingCard(state: WakeState, cardId: string, layout: Layout, note?: string): CardMessage {
		return renderCard(state.server, { cardId, layout, game: state.game, note, updatedAt: state.updatedAt });
	}

	// the alarm belongs to wake polling while a wake runs; otherwise it times the next panel check
	private async schedulePanelCheck(server: SharedServer): Promise<void> {
		if (await this.loadWake()) {
			return;
		}
		if (Object.keys(await this.panels()).length === 0) {
			await this.scheduleCleanup();
			return;
		}
		const next = nextPanelCheck(server, Date.now());
		if (next === null) {
			await this.ctx.storage.deleteAlarm();
		} else {
			await this.ctx.storage.setAlarm(next);
		}
	}

	private async takeWakeBudget(): Promise<boolean> {
		const now = Date.now();
		const recent = (await this.ctx.storage.get<number[]>('wakeLog') ?? []).filter(at => now - at < WAKE_BUDGET_WINDOW_MS);
		if (recent.length >= WAKE_BUDGET) {
			return false;
		}
		recent.push(now);
		await this.ctx.storage.put('wakeLog', recent);
		return true;
	}

	private async finishWake(server: SharedServer): Promise<void> {
		await this.ctx.storage.delete('wake');
		await this.schedulePanelCheck(server);
	}

	private async pingWakers(state: WakeState, joinAddress: string | null): Promise<void> {
		let join = '';
		if (joinAddress) {
			join = ` Join: \`${joinAddress}\``;
		}
		await Promise.all(Object.entries(state.wakers).map(async ([userId, token]) => {
			try {
				await createFollowup(this.env, token, {
					content: `<@${userId}> your server is online.${join}`,
					allowed_mentions: { users: [userId] },
				});
			} catch (err) {
				console.error('Failed to ping Lite waker', userId, err);
			}
		}));
	}

	// how long people waited and how it ended, measured from the first click
	private trackFinish(state: WakeState, outcome: 'failed' | 'link_unusable' | 'online' | 'timed_out'): void {
		trackEvent(this.env, {
			event: 'wake_finished',
			outcome,
			shareId: state.shareId,
			module: state.server.module,
			durationMs: Date.now() - state.startedAt,
		});
	}

	private async pollWake(state: WakeState): Promise<void> {
		const timedOut = Date.now() - state.startedAt >= WAKE_TIMEOUT_MS;

		let server: SharedServer;
		try {
			server = await getSharedServer(await this.client(), state.shareId);
		} catch (err) {
			if (isUnusableLink(err)) {
				await this.renderAll(state, cardId => renderNotice(errorMessage(err), cardId));
				// panels stay registered like in checkPanels, so the database still matches and a fixed link brings them back
				await this.ctx.storage.delete('wake');
				await this.scheduleCleanup();
				this.trackFinish(state, 'link_unusable');
				return;
			}
			// treat anything else as transient and poll again
			console.error('Lite status poll failed', state.shareId, err);
			if (timedOut) {
				await this.finishWake(state.server);
				this.trackFinish(state, 'timed_out');
			} else {
				await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
			}
			return;
		}
		state.server = server;
		state.updatedAt = Date.now();
		await this.ctx.storage.put('snapshot', { server, game: state.game, at: state.updatedAt });
		const view = describeServer(server, state.game);

		if (isServerUp(server)) {
			await this.renderAll(state, (cardId, layout) => this.restingCard(state, cardId, layout));
			// finish first, so an alarm that fires twice doesn't ping everyone twice
			await this.finishWake(server);
			this.trackFinish(state, 'online');
			await this.pingWakers(state, view.joinAddress);
			return;
		}
		if (view.state === 'waking' || view.state === 'starting') {
			state.sawProgress = true;
		} else if (state.sawProgress && view.state === 'hibernating') {
			// controller rolls a failed wake back to stored; other resting states are just the container still booting
			await this.renderAll(state, (cardId, layout) => this.restingCard(state, cardId, layout, 'The server didn\'t finish waking. Try again, or ask the owner to check Nodecraft.'));
			await this.finishWake(server);
			this.trackFinish(state, 'failed');
			return;
		}
		if (state.progress === 'waking' && server.jit_status !== 'stored' && server.jit_status !== 'waking') {
			state.progress = 'starting';
		}
		if (timedOut) {
			await this.renderAll(state, (cardId, layout) => this.restingCard(state, cardId, layout, 'This is taking longer than usual. Press Refresh in a minute.'));
			await this.finishWake(server);
			this.trackFinish(state, 'timed_out');
			return;
		}

		await this.renderAll(state, (cardId, layout) => this.progressCard(state, cardId, layout));
		await this.ctx.storage.put('wake', state);
		await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
	}

	private async checkPanels(): Promise<void> {
		// watchers are always reached by share ID, and the runtime keeps that name for alarms too
		const shareId = this.ctx.id.name;
		if (!shareId) {
			return;
		}
		let snapshot: Snapshot;
		try {
			snapshot = await this.fetchSnapshot(await this.client(), shareId);
		} catch (err) {
			if (isUnusableLink(err)) {
				// a locked or regenerated link only changes when someone acts, so stop checking until a click
				await this.renderPanels(cardId => renderNotice(errorMessage(err), cardId));
				return;
			}
			console.error('Lite panel check failed', shareId, err);
			await this.ctx.storage.setAlarm(Date.now() + PANEL_RETRY_MS);
			return;
		}
		await this.renderPanels(cardId => renderCard(snapshot.server, { cardId, layout: 'panel', game: snapshot.game, updatedAt: snapshot.at }));
		await this.schedulePanelCheck(snapshot.server);
	}

	private async addPanel(request: WatchPanelRequest): Promise<void> {
		const panels = await this.panels();
		panels[request.cardId] = request.message;
		await this.ctx.storage.put('panels', panels);
		await this.ctx.storage.put('snapshot', { server: request.server, game: request.game, at: Date.now() });
		await this.schedulePanelCheck(request.server);
	}

	private async removePanel(cardId: string): Promise<void> {
		const panels = await this.panels();
		delete panels[cardId];
		await this.ctx.storage.put('panels', panels);
		if (Object.keys(panels).length === 0 && !(await this.loadWake())) {
			await this.scheduleCleanup();
		}
	}

	private async beginWake(request: WakeRequest): Promise<WakeResult> {
		await this.remember(request);
		const target = { token: request.token, addedAt: Date.now(), panel: request.panel };
		const existing = await this.loadWake();
		if (existing) {
			existing.targets[request.cardId] = target;
			existing.wakers[request.userId] = request.token;
			await this.ctx.storage.put('wake', existing);
			await this.edit(request.cardId, target, this.progressCard(existing, request.cardId, layoutFor(target)));
			return { ok: true, outcome: 'joined', module: existing.server.module };
		}

		const client = await this.client();
		let snapshot: Snapshot;
		try {
			snapshot = await this.fetchSnapshot(client, request.shareId);
		} catch (err) {
			return failure(err, null, null);
		}
		const { server, game } = snapshot;
		const view = describeServer(server);
		const alreadyMoving = view.state === 'waking' || view.state === 'starting';
		if (!view.action && !alreadyMoving) {
			await this.edit(request.cardId, target, renderCard(server, { cardId: request.cardId, layout: layoutFor(target), game }));
			await this.schedulePanelCheck(server);
			return { ok: true, outcome: 'no_action', module: server.module };
		}
		if (!(await this.takeWakeBudget())) {
			await this.edit(request.cardId, target, renderCard(server, {
				cardId: request.cardId,
				layout: layoutFor(target),
				game,
				note: 'This server has been woken a lot in the last hour. Try again later, or wake it from Nodecraft.',
			}));
			return { ok: true, outcome: 'over_budget', module: server.module };
		}
		let progress: WakeState['progress'] = 'starting';
		if (view.action === 'wake' || view.state === 'waking') {
			progress = 'waking';
		}
		const now = Date.now();
		if (view.action) {
			// controller's start can take several seconds while it picks a node, so the clicker sees the wake begin first
			await this.edit(request.cardId, target, renderCard(server, {
				cardId: request.cardId,
				layout: layoutFor(target),
				game,
				progress: { state: progress, since: now },
			}));
			try {
				await startSharedServer(client, request.shareId, request.password, `discord:${request.userId}`);
			} catch (err) {
				return failure(err, server, game);
			}
		}

		const state: WakeState = {
			shareId: request.shareId,
			startedAt: now,
			progress,
			sawProgress: alreadyMoving,
			server,
			game,
			updatedAt: now,
			targets: { [request.cardId]: target },
			wakers: { [request.userId]: request.token },
		};
		await this.ctx.storage.put('wake', state);
		await this.ctx.storage.setAlarm(now + POLL_INTERVAL_MS);
		await this.renderAll(state, (cardId, layout) => this.progressCard(state, cardId, layout));
		return { ok: true, outcome: 'started', module: server.module };
	}

	private async refreshCard(request: RefreshRequest): Promise<void> {
		await this.remember(request);
		const target = { token: request.token, addedAt: Date.now(), panel: request.panel };
		const existing = await this.loadWake();
		if (existing) {
			existing.targets[request.cardId] = target;
			await this.ctx.storage.put('wake', existing);
			await this.edit(request.cardId, target, this.progressCard(existing, request.cardId, layoutFor(target)));
			return;
		}
		try {
			let snapshot = await this.ctx.storage.get<Snapshot>('snapshot');
			if (!snapshot || Date.now() - snapshot.at >= REFRESH_COOLDOWN_MS) {
				snapshot = await this.fetchSnapshot(await this.client(), request.shareId);
			}
			await this.edit(request.cardId, target, renderCard(snapshot.server, {
				cardId: request.cardId,
				layout: layoutFor(target),
				game: snapshot.game,
				updatedAt: snapshot.at,
			}));
			await this.schedulePanelCheck(snapshot.server);
		} catch (err) {
			await this.edit(request.cardId, target, renderNotice(errorMessage(err), request.cardId));
		}
	}

	// a burst of changes (waking, live, hot) shares one check, and the cooldown caps how often pushes can reach controller
	private async checkSoon(): Promise<void> {
		if (!(await this.loadWake()) && Object.keys(await this.panels()).length === 0) {
			return;
		}
		const snapshot = await this.ctx.storage.get<Snapshot>('snapshot');
		let at = Date.now();
		if (snapshot) {
			at = Math.max(at, snapshot.at + REFRESH_COOLDOWN_MS);
		}
		const scheduled = await this.ctx.storage.getAlarm();
		if (scheduled === null || at < scheduled) {
			await this.ctx.storage.setAlarm(at);
		}
	}

	private async runAlarm(): Promise<AlarmJob> {
		// an operator kill switch: each watcher stops at its next alarm instead of rescheduling
		if (this.env.LITE_BACKGROUND_UPDATES === 'off') {
			return 'paused';
		}
		const state = await this.ctx.storage.get<WakeState>('wake');
		if (state) {
			await this.pollWake(state);
			return 'wake_poll';
		}
		if (Object.keys(await this.panels()).length === 0) {
			await this.cleanUp();
			return 'cleanup';
		}
		await this.checkPanels();
		return 'panel_check';
	}

	watchPanel(request: WatchPanelRequest): Promise<void> {
		return this.exclusive(() => this.addPanel(request));
	}

	unwatchPanel(cardId: string): Promise<void> {
		return this.exclusive(() => this.removePanel(cardId));
	}

	wake(request: WakeRequest): Promise<WakeResult> {
		return this.exclusive(() => this.beginWake(request));
	}

	refresh(request: RefreshRequest): Promise<void> {
		return this.exclusive(() => this.refreshCard(request));
	}

	// controller calls this through /lite/updates whenever the share's server changes state
	changed(): Promise<void> {
		return this.exclusive(() => this.checkSoon());
	}

	alarm(): Promise<void> {
		return this.exclusive(async () => {
			const startedAt = Date.now();
			// the job is only known once it finishes, and a throw means the runtime retries the alarm
			let job = 'unknown';
			let outcome = 'error';
			try {
				job = await this.runAlarm();
				outcome = 'ok';
			} finally {
				trackTechnical(this.env, { type: 'alarm', name: job, outcome, durationMs: Date.now() - startedAt });
			}
		});
	}
}
