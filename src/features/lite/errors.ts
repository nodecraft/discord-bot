import { nodecraftErrorCode, nodecraftErrorFields } from '../../nodecraft/controller.ts';

const MESSAGES: Record<string, string> = {
	'instances.jit_not_found': 'This share link no longer works. Ask the owner for a new one.',
	'instances.jit_locked': 'The owner has locked this server.',
	'instances.jit_storing': 'This server is still saving to hibernate. Try again in a few minutes.',
	'instances.share_unavailable': 'This server is archived. The owner needs to deploy it again in Nodecraft before it can start.',
	'services.already_deployed': 'This Lite plan is running another server right now.',
	'instances.no_availability': 'This server\'s location is full right now. The owner can move it to another location in Nodecraft.',
	'instances.not_deployable': 'This server is busy. Try again in a moment.',
	'instances.already_deployed': 'This server is busy. Try again in a moment.',
};

const FALLBACK = 'Something went wrong talking to Nodecraft. Try again in a moment.';

// errors where the share link itself is unusable, so the card can't show a server at all
export const UNUSABLE_LINK_CODES = new Set(['instances.jit_not_found', 'instances.jit_locked']);

export function isPasswordError(err: unknown): boolean {
	return nodecraftErrorCode(err) === 'express.validation' && 'password' in nodecraftErrorFields(err);
}

export function isUnusableLink(err: unknown): boolean {
	return UNUSABLE_LINK_CODES.has(nodecraftErrorCode(err) ?? '');
}

export function errorMessage(err: unknown): string {
	return MESSAGES[nodecraftErrorCode(err) ?? ''] ?? FALLBACK;
}
