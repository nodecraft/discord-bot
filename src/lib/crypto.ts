const IV_BYTES = 12;
export const CURRENT_KEY_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fromBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), char => char.codePointAt(0) ?? 0);
}

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCodePoint(...bytes));
}

// hashing first gives timingSafeEqual the equal lengths it requires, without leaking the secret's length
export async function secretsMatch(given: string | undefined, expected: string): Promise<boolean> {
	if (!given || !expected) {
		return false;
	}
	const [givenHash, expectedHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(given)),
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
	]);
	return crypto.subtle.timingSafeEqual(givenHash, expectedHash);
}

function importKey(base64Key: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', fromBase64(base64Key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// `context` is bound as additional data, so a ciphertext copied onto another row fails to decrypt
export async function encryptSecret(base64Key: string, plaintext: string, context: string): Promise<string> {
	const key = await importKey(base64Key);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
		key,
		encoder.encode(plaintext),
	);
	const sealed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
	sealed.set(iv);
	sealed.set(new Uint8Array(ciphertext), IV_BYTES);
	return toBase64(sealed);
}

export async function decryptSecret(base64Key: string, sealedBase64: string, context: string): Promise<string> {
	const key = await importKey(base64Key);
	const sealed = fromBase64(sealedBase64);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: sealed.slice(0, IV_BYTES), additionalData: encoder.encode(context) },
		key,
		sealed.slice(IV_BYTES),
	);
	return decoder.decode(plaintext);
}
