const UUID = String.raw`[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}`;
const SHARE_LINK = new RegExp(String.raw`https?://(?:[\w-]+\.)*nodecraft\.com/shared/(${UUID})`, 'i');
const BARE_SHARE_ID = new RegExp(String.raw`^\s*(${UUID})\s*$`, 'i');

// Finds the first share link in free text, such as a message someone right-clicked
export function findShareId(text: string): string | null {
	const match = SHARE_LINK.exec(text);
	if (!match?.[1]) {
		return null;
	}
	return match[1].toLowerCase();
}

// Command input also accepts a bare share ID, since people copy it from nodepanel's settings page
export function parseShareInput(input: string): string | null {
	const bare = BARE_SHARE_ID.exec(input);
	if (bare?.[1]) {
		return bare[1].toLowerCase();
	}
	return findShareId(input);
}

export function shareLink(shareId: string): string {
	return `https://app.nodecraft.com/shared/${shareId}`;
}
