const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[\da-f]+$/i.test(hex)) {
		return null;
	}
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, (index * 2) + 2), 16);
	}
	return bytes;
}

// Discord removes the endpoint if it ever accepts a bad signature, so every failure path returns false
export async function verifyDiscordRequest(
	signature: string | undefined,
	timestamp: string | undefined,
	body: string,
	publicKey: string,
): Promise<boolean> {
	if (!signature || !timestamp) {
		return false;
	}
	const signatureBytes = hexToBytes(signature);
	const keyBytes = hexToBytes(publicKey);
	if (!signatureBytes || !keyBytes) {
		return false;
	}
	try {
		const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
		return await crypto.subtle.verify({ name: 'Ed25519' }, key, signatureBytes, encoder.encode(timestamp + body));
	} catch {
		return false;
	}
}
