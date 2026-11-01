/**
 * Pairing and end-to-end encryption for remote access (server/remote.ts). The phone side is a copy of this protocol
 * in Sorvex-Browser's src/lib/protocol.ts (built on @noble, since WebCrypto is missing on plain-HTTP LAN pages);
 * both repos test the same vector, so change them together.
 *
 * Two credentials, never mixed:
 * - Pairing code: 10 random bytes shown as `XXXX-XXXX-XXXX-XXXX`. Valid for one minute and for one phone. The phone
 *   finds the host in a relay room derived from the code, and both prove they know it.
 * - Device key: 32 random bytes the host gives each phone at pairing. Later connections prove knowledge of it.
 *   Revoking a phone deletes its key on the host.
 *
 * Every handshake runs an ephemeral X25519 exchange, and the proofs cover both ephemeral public keys, so a relay in
 * the middle cannot swap them. Session keys come from HKDF over the X25519 secret plus the code or device key, salted
 * with both nonces. A leaked device key therefore cannot decrypt traffic recorded earlier.
 *
 * Frames are AES-256-GCM with a random IV; the receiver requires a strictly increasing `seq` inside each frame.
 */

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const CODE_BYTES = 10;
export const DEVICE_KEY_BYTES = 32;
const NONCE_BYTES = 16;
/** DER prefixes that wrap a raw 32-byte X25519 key as PKCS#8 (private) or SPKI (public). */
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

export function generateCode(): Buffer {
	return randomBytes(CODE_BYTES);
}

export function generateNonce(): string {
	return randomBytes(NONCE_BYTES).toString("base64");
}

/** 32 hex characters: device ids and the host's permanent relay room. */
export function generateId(): string {
	return randomBytes(16).toString("hex");
}

export function generateDeviceKey(): Buffer {
	return randomBytes(DEVICE_KEY_BYTES);
}

/** `ABCD-EFGH-...`: base32 without padding, in groups of 4. */
export function encodeCode(code: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of code) {
		value = ((value << 8) | byte) & 0xffff;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return (out.match(/.{1,4}/g) ?? []).join("-");
}

/** Accepts any case, spaces and dashes, and the usual look-alikes (0/O, 1/I, 8/B). Returns undefined if invalid. */
export function decodeCode(text: string): Buffer | undefined {
	const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B");
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];
	for (const char of clean) {
		const index = BASE32.indexOf(char);
		if (index < 0) return undefined;
		value = ((value << 5) | index) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return bytes.length === CODE_BYTES ? Buffer.from(bytes) : undefined;
}

/** The relay room where a phone holding `code` finds the host during pairing. */
export function pairingRoom(code: Uint8Array): string {
	return createHash("sha256").update("sorvex-pair-room:").update(code).digest("hex").slice(0, 32);
}

export interface EphemeralKey {
	privateKey: KeyObject;
	/** Raw public key, base64. */
	publicKey: string;
}

/** A fresh X25519 key pair. `raw` is only passed by tests. */
export function ephemeralKey(raw?: Uint8Array): EphemeralKey {
	const privateKey = raw
		? createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: "der", type: "pkcs8" })
		: generateKeyPairSync("x25519").privateKey;
	const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
	return { privateKey, publicKey: spki.subarray(spki.length - 32).toString("base64") };
}

/** Throws on a malformed peer key. */
export function sharedSecret(own: EphemeralKey, peerPublicKey: string): Buffer {
	const raw = Buffer.from(peerPublicKey, "base64");
	if (raw.length !== 32) throw new Error("Bad public key");
	const publicKey = createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: "der", type: "spki" });
	return diffieHellman({ privateKey: own.privateKey, publicKey });
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Buffer {
	return Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));
}

function proof(secret: Uint8Array, text: string): string {
	return createHmac("sha256", hkdf(secret, new Uint8Array(0), "sorvex-auth")).update(text).digest("base64");
}

/** Phone → host when pairing: proves the phone holds the code, bound to its ephemeral key. */
export function pairProof(code: Uint8Array, phoneKey: string, phoneNonce: string): string {
	return proof(code, `pair:${phoneKey}:${phoneNonce}`);
}

/** Host → phone when pairing: proves the host holds the code, bound to both ephemeral keys. */
export function pairedProof(code: Uint8Array, phoneKey: string, hostKey: string, phoneNonce: string, hostNonce: string): string {
	return proof(code, `paired:${phoneKey}:${hostKey}:${phoneNonce}:${hostNonce}`);
}

/** Phone → host on every later connection: proves the phone holds its device key. */
export function helloProof(deviceKey: Uint8Array, deviceId: string, phoneKey: string, phoneNonce: string): string {
	return proof(deviceKey, `hello:${deviceId}:${phoneKey}:${phoneNonce}`);
}

export function welcomeProof(deviceKey: Uint8Array, phoneKey: string, hostKey: string, phoneNonce: string, hostNonce: string): string {
	return proof(deviceKey, `welcome:${phoneKey}:${hostKey}:${phoneNonce}:${hostNonce}`);
}

export function proofMatches(expected: string, actual: unknown): boolean {
	if (typeof actual !== "string") return false;
	const a = Buffer.from(expected, "base64");
	const b = Buffer.from(actual, "base64");
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Keys for one connection: `c2h` encrypts phone-to-host frames, `h2c` host-to-phone. `secret` is the pairing code
 * or the device key; `shared` is the X25519 result.
 */
export function sessionKeys(shared: Uint8Array, secret: Uint8Array, phoneNonce: string, hostNonce: string): { c2h: Buffer; h2c: Buffer } {
	const ikm = Buffer.concat([shared, secret]);
	const salt = Buffer.concat([Buffer.from(phoneNonce, "base64"), Buffer.from(hostNonce, "base64")]);
	return { c2h: hkdf(ikm, salt, "sorvex-c2h"), h2c: hkdf(ikm, salt, "sorvex-h2c") };
}

/** base64(iv || ciphertext || tag). `iv` is only passed by tests. */
export function seal(key: Uint8Array, plaintext: string, iv: Uint8Array = randomBytes(12)): string {
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

/** Throws if the frame was tampered with or encrypted with another key. */
export function open(key: Uint8Array, frame: string): string {
	const data = Buffer.from(frame, "base64");
	if (data.length < 28) throw new Error("Frame too short");
	const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
	decipher.setAuthTag(data.subarray(data.length - 16));
	return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
}
