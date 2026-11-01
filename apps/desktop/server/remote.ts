/**
 * Remote access: lets phones drive this server through a relay (Sorvex-Browser's relay/server.ts), which also
 * serves the mobile web app. The server dials out to the relay, so the host needs no open port.
 *
 *   phone ──WSS──▶ relay ◀──WSS── this server
 *
 * Pairing and access are separate (protocol in server/remote-crypto.ts):
 * - Pairing: "Pair a phone" opens a 5-minute window with a one-time code. It changes every minute, and the first
 *   phone that proves it holds it burns it, so a code works for exactly one phone. With `requireApproval`, the
 *   desktop must also click Allow. The phone then gets its own device key.
 * - Access: paired phones connect to this host's permanent room and prove their device key. Revoking a phone
 *   deletes its key; phones unused for 30 days are revoked automatically.
 *
 * The relay only routes frames by room. After each handshake everything is end-to-end encrypted. Phones may only call
 * REMOTE_ROUTES and receive REMOTE_EVENTS; credentials, SSH, MCP, the browser and these settings stay local.
 *
 * Relay frames (JSON text):
 *   relay → host: {type:"open", client} | {type:"data", client, data} | {type:"close", client} | {type:"ping"}
 *   host → relay: {type:"data", client, data} | {type:"kick", client}
 * `data` is a handshake message ({t:"pair"|"paired"|"waiting"|"hello"|"welcome"|"reject"}) or {t:"sealed", d}.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Hub } from "./hub.ts";
import { remotePath } from "./paths.ts";
import {
	DEVICE_KEY_BYTES,
	encodeCode,
	ephemeralKey,
	generateCode,
	generateDeviceKey,
	generateId,
	generateNonce,
	helloProof,
	open,
	pairedProof,
	pairingRoom,
	pairProof,
	proofMatches,
	seal,
	sessionKeys,
	sharedSecret,
	welcomeProof,
} from "./remote-crypto.ts";

export type Dispatch = (method: string, path: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

/** Routes a paired phone may call. Everything else answers 403. */
const REMOTE_ROUTES = new Set([
	"GET /api/health",
	"GET /api/state",
	"GET /api/sessions",
	"POST /api/agent/rpc",
	"POST /api/agent/ui",
	"POST /api/agent/start",
	"POST /api/agent/cwd",
	"GET /api/settings",
	"GET /api/sorvex-settings",
	"PUT /api/sorvex-settings",
	"POST /api/sessions/delete",
]);

/** Server events forwarded to phones. */
const REMOTE_EVENTS = new Set(["agent", "agent-status", "models-changed", "dialog-resolved"]);

/** Without any frame from the relay for this long (it pings every 25 s), the connection is treated as dead. */
const RELAY_TIMEOUT_MS = 70_000;
const PAIRING_WINDOW_MS = 5 * 60_000;
const CODE_LIFETIME_MS = 60_000;
/** A phone that scanned a code just before it changed may still finish with it. */
const CODE_GRACE_MS = 10_000;
const APPROVAL_TIMEOUT_MS = 2 * 60_000;
/** Wrong proofs against one code before it is replaced. */
const MAX_PAIR_FAILURES = 5;
const DEVICE_EXPIRY_MS = 30 * 24 * 60 * 60_000;

export type RelayState = "off" | "connecting" | "online" | "error";

interface StoredDevice {
	id: string;
	name: string;
	/** Base64 device key. */
	key: string;
	pairedAt: number;
	lastSeen: number;
}

interface StoredRemote {
	enabled: boolean;
	relayUrl: string;
	/** This host's permanent relay room. Only paired phones learn it. */
	hostId: string;
	requireApproval: boolean;
	devices: StoredDevice[];
}

interface Session {
	client: string;
	deviceId: string;
	keys: { c2h: Buffer; h2c: Buffer };
	sendSeq: number;
	recvSeq: number;
}

interface PairingCode {
	code: Buffer;
	room: RelayRoom;
	failures: number;
	/** Set by the first valid proof. A spent code never pairs another phone, whatever happens next. */
	spent: boolean;
}

/** A phone that proved a pairing code and waits for the desktop to allow it. */
interface PairRequest {
	id: string;
	name: string;
	pairing: PairingCode;
	client: string;
	phoneKey: string;
	phoneNonce: string;
	timer: NodeJS.Timeout;
}

interface Pairing {
	current: PairingCode;
	/** Replaced codes, still accepted for CODE_GRACE_MS. */
	retiring: PairingCode[];
	codeExpiresAt: number;
	endsAt: number;
	rotateTimer: NodeJS.Timeout;
	endTimer: NodeJS.Timeout;
	request?: PairRequest;
}

type Handshake = { t?: string; key?: unknown; nonce?: unknown; proof?: unknown; name?: unknown; device?: unknown; d?: unknown };

interface Inner {
	seq: number;
	t: string;
	id?: number;
	method?: string;
	path?: string;
	body?: Record<string, unknown>;
}

export interface RemoteStatus {
	enabled: boolean;
	relayUrl: string;
	requireApproval: boolean;
	relay: RelayState;
	error?: string;
	devices: { id: string; name: string; pairedAt: number; lastSeen: number; connected: boolean }[];
	pairing?: { code: string; pairUrl: string; codeExpiresAt: number; endsAt: number; request?: { id: string; name: string } };
}

/** `https://relay.example` (or ws/wss, with or without a trailing slash) → http(s) and ws(s) base URLs. */
export function relayUrls(relayUrl: string): { http: string; ws: string } {
	const url = new URL(relayUrl.trim());
	if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error("The relay URL must start with http(s):// or ws(s)://");
	const secure = url.protocol === "https:" || url.protocol === "wss:";
	const base = `${url.host}${url.pathname.replace(/\/+$/, "")}`;
	return { http: `${secure ? "https" : "http"}://${base}`, ws: `${secure ? "wss" : "ws"}://${base}` };
}

/** One host connection to a relay room, reconnecting with backoff until closed. */
class RelayRoom {
	state: RelayState = "connecting";
	error: string | undefined;
	private socket: WebSocket | undefined;
	private closed = false;
	private retries = 0;
	private retryTimer: NodeJS.Timeout | undefined;
	private watchdog: NodeJS.Timeout | undefined;
	private readonly url: string;
	private readonly onFrame: (frame: { type?: string; client?: string; data?: Handshake }) => void;
	private readonly onState: () => void;

	constructor(url: string, onFrame: RelayRoom["onFrame"], onState: () => void) {
		this.url = url;
		this.onFrame = onFrame;
		this.onState = onState;
		this.connect();
	}

	send(frame: Record<string, unknown>): void {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.retryTimer);
		clearTimeout(this.watchdog);
		this.socket?.close();
		this.socket = undefined;
	}

	private setState(state: RelayState, error?: string): void {
		this.state = state;
		this.error = error;
		this.onState();
	}

	private connect(): void {
		const socket = new WebSocket(this.url);
		this.socket = socket;
		let failure: string | undefined;
		socket.addEventListener("open", () => {
			if (this.socket !== socket) return;
			this.retries = 0;
			this.setState("online");
			this.feedWatchdog(socket);
		});
		socket.addEventListener("message", (message) => {
			if (this.socket !== socket) return;
			this.feedWatchdog(socket);
			if (typeof message.data !== "string") return;
			try {
				this.onFrame(JSON.parse(message.data));
			} catch {
				// Not JSON: ignore.
			}
		});
		socket.addEventListener("error", () => {
			failure = "Cannot reach the relay";
		});
		socket.addEventListener("close", (event) => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			clearTimeout(this.watchdog);
			if (this.closed) return;
			// 4001: the relay handed this room to a newer connection, e.g. a second copy of Sorvex Desktop.
			if (event.code === 4001) return this.setState("error", "Another Sorvex Desktop took over this room");
			this.setState("error", failure ?? (event.reason || "Relay connection closed"));
			const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
			this.retryTimer = setTimeout(() => !this.closed && this.connect(), delay);
			this.retryTimer.unref();
		});
	}

	private feedWatchdog(socket: WebSocket): void {
		clearTimeout(this.watchdog);
		this.watchdog = setTimeout(() => {
			if (this.socket === socket) socket.close(4002, "Relay timed out");
		}, RELAY_TIMEOUT_MS);
		this.watchdog.unref();
	}
}

export class RemoteAccess {
	private readonly hub: Hub;
	private readonly dispatch: Dispatch;
	private config: StoredRemote;
	private room: RelayRoom | undefined;
	private sessions = new Map<string, Session>();
	private pairing: Pairing | undefined;

	constructor(hub: Hub, dispatch: Dispatch) {
		this.hub = hub;
		this.dispatch = dispatch;
		this.config = this.load();
		hub.subscribe((event, data) => {
			if (REMOTE_EVENTS.has(event)) for (const session of this.sessions.values()) this.sendSealed(session, { t: "event", event, data });
		});
		if (this.config.enabled) this.connect();
	}

	status(): RemoteStatus {
		const connected = new Set([...this.sessions.values()].map((session) => session.deviceId));
		const pairing = this.pairing;
		return {
			enabled: this.config.enabled,
			relayUrl: this.config.relayUrl,
			requireApproval: this.config.requireApproval,
			relay: this.room?.state ?? "off",
			error: this.room?.state === "error" ? this.room.error : undefined,
			devices: this.config.devices.map(({ id, name, pairedAt, lastSeen }) => ({ id, name, pairedAt, lastSeen, connected: connected.has(id) })),
			pairing: pairing && {
				code: encodeCode(pairing.current.code),
				pairUrl: `${relayUrls(this.config.relayUrl).http}/#p=${encodeCode(pairing.current.code)}`,
				codeExpiresAt: pairing.codeExpiresAt,
				endsAt: pairing.endsAt,
				request: pairing.request && { id: pairing.request.id, name: pairing.request.name },
			},
		};
	}

	configure(patch: { enabled?: unknown; relayUrl?: unknown; requireApproval?: unknown }): RemoteStatus {
		const relayUrl = typeof patch.relayUrl === "string" ? patch.relayUrl.trim() : this.config.relayUrl;
		const enabled = typeof patch.enabled === "boolean" ? patch.enabled : this.config.enabled;
		const requireApproval = typeof patch.requireApproval === "boolean" ? patch.requireApproval : this.config.requireApproval;
		if (relayUrl) relayUrls(relayUrl);
		if (enabled && !relayUrl) throw new Error("Set a relay URL first");
		const reconnect = enabled !== this.config.enabled || relayUrl !== this.config.relayUrl;
		this.config = { ...this.config, relayUrl, enabled, requireApproval };
		this.save();
		if (reconnect) {
			this.disconnect();
			if (enabled) this.connect();
		}
		this.announce();
		return this.status();
	}

	/** Opens the pairing window with a fresh one-time code. */
	startPairing(): RemoteStatus {
		if (!this.config.enabled) throw new Error("Turn on remote access first");
		this.stopPairing();
		const now = Date.now();
		const current = this.openPairingCode();
		this.pairing = {
			current,
			retiring: [],
			codeExpiresAt: now + CODE_LIFETIME_MS,
			endsAt: now + PAIRING_WINDOW_MS,
			rotateTimer: setTimeout(() => this.rotateCode(), CODE_LIFETIME_MS),
			endTimer: setTimeout(() => this.stopPairing(), PAIRING_WINDOW_MS),
		};
		this.announce();
		return this.status();
	}

	stopPairing(): RemoteStatus {
		const pairing = this.pairing;
		if (!pairing) return this.status();
		this.pairing = undefined;
		clearTimeout(pairing.rotateTimer);
		clearTimeout(pairing.endTimer);
		if (pairing.request) this.declineRequest(pairing.request, "Pairing was cancelled on the computer");
		for (const code of [pairing.current, ...pairing.retiring]) code.room.close();
		this.announce();
		return this.status();
	}

	/** The desktop's answer to a phone waiting for approval. */
	answerPairing(id: string, allow: boolean): RemoteStatus {
		const pairing = this.pairing;
		const request = pairing?.request;
		if (!pairing || !request || request.id !== id) throw new Error("That pairing request is no longer waiting");
		clearTimeout(request.timer);
		if (allow) this.completePairing(request);
		else {
			this.declineRequest(request, "The computer declined this phone");
			pairing.request = undefined;
			this.rotateCode();
		}
		return this.status();
	}

	revoke(id: string): RemoteStatus {
		this.config = { ...this.config, devices: this.config.devices.filter((device) => device.id !== id) };
		this.save();
		for (const session of [...this.sessions.values()]) {
			if (session.deviceId !== id) continue;
			this.sendSealed(session, { t: "bye", reason: "This phone was removed from the computer" });
			this.room?.send({ type: "kick", client: session.client });
			this.sessions.delete(session.client);
		}
		this.announce();
		return this.status();
	}

	revokeAll(): RemoteStatus {
		for (const device of this.config.devices) this.revoke(device.id);
		return this.status();
	}

	stop(): void {
		this.disconnect();
	}

	private load(): StoredRemote {
		const fallback: StoredRemote = { enabled: false, relayUrl: process.env.SORVEX_RELAY_URL ?? "", hostId: "", requireApproval: true, devices: [] };
		let stored = fallback;
		try {
			if (existsSync(remotePath)) stored = { ...fallback, ...(JSON.parse(readFileSync(remotePath, "utf8")) as Partial<StoredRemote>) };
		} catch {
			// A corrupt file starts over: no paired phones.
		}
		const cutoff = Date.now() - DEVICE_EXPIRY_MS;
		const devices = (Array.isArray(stored.devices) ? stored.devices : []).filter(
			(device) => device.lastSeen > cutoff && Buffer.from(String(device.key), "base64").length === DEVICE_KEY_BYTES,
		);
		const hostId = /^[0-9a-f]{32}$/.test(String(stored.hostId)) ? stored.hostId : generateId();
		// Rewrite the file, which also drops keys from older formats such as a shared pairing secret.
		this.config = { enabled: stored.enabled === true, relayUrl: String(stored.relayUrl ?? ""), requireApproval: stored.requireApproval !== false, hostId, devices };
		this.save();
		return this.config;
	}

	private save(): void {
		mkdirSync(dirname(remotePath), { recursive: true });
		writeFileSync(remotePath, JSON.stringify(this.config, null, 2), { mode: 0o600 });
	}

	private connect(): void {
		const url = `${relayUrls(this.config.relayUrl).ws}/ws?role=host&room=${this.config.hostId}`;
		const room = new RelayRoom(
			url,
			(frame) => this.onHostFrame(frame),
			() => {
				// A dropped relay connection drops every phone connection with it.
				if (room.state !== "online") this.sessions.clear();
				this.announce();
			},
		);
		this.room = room;
	}

	private disconnect(): void {
		this.stopPairing();
		this.room?.close();
		this.room = undefined;
		this.sessions.clear();
	}

	/** Tells the desktop UI about relay, device and pairing changes. */
	private announce(): void {
		this.hub.broadcast("remote", this.status());
	}

	private sendSealed(session: Session, message: Record<string, unknown>): void {
		const d = seal(session.keys.h2c, JSON.stringify({ seq: ++session.sendSeq, ...message }));
		this.room?.send({ type: "data", client: session.client, data: { t: "sealed", d } });
	}

	// ----- Pairing -----

	private openPairingCode(): PairingCode {
		const code = generateCode();
		const url = `${relayUrls(this.config.relayUrl).ws}/ws?role=host&room=${pairingRoom(code)}`;
		const entry: { code: Buffer; failures: number; spent: boolean; room?: RelayRoom } = { code, failures: 0, spent: false };
		const pairingCode = entry as PairingCode;
		entry.room = new RelayRoom(url, (frame) => this.onPairingFrame(pairingCode, frame), () => undefined);
		return pairingCode;
	}

	/** Replaces the current code; the old one keeps working for CODE_GRACE_MS. */
	private rotateCode(): void {
		const pairing = this.pairing;
		if (!pairing) return;
		clearTimeout(pairing.rotateTimer);
		const old = pairing.current;
		pairing.retiring.push(old);
		setTimeout(() => {
			if (pairing.request?.pairing === old) return;
			old.room.close();
			pairing.retiring = pairing.retiring.filter((code) => code !== old);
		}, CODE_GRACE_MS).unref();
		pairing.current = this.openPairingCode();
		pairing.codeExpiresAt = Date.now() + CODE_LIFETIME_MS;
		pairing.rotateTimer = setTimeout(() => this.rotateCode(), CODE_LIFETIME_MS);
		this.announce();
	}

	private onPairingFrame(code: PairingCode, frame: { type?: string; client?: string; data?: Handshake }): void {
		const pairing = this.pairing;
		const client = String(frame.client ?? "");
		if (frame.type === "close" && pairing?.request?.client === client && pairing.request.pairing === code) {
			// The phone gave up while waiting for approval.
			clearTimeout(pairing.request.timer);
			pairing.request = undefined;
			this.rotateCode();
			return;
		}
		if (frame.type !== "data" || frame.data?.t !== "pair" || !pairing) return;
		const live = code === pairing.current || pairing.retiring.includes(code);
		const data = frame.data;
		const phoneKey = typeof data.key === "string" ? data.key : "";
		const phoneNonce = typeof data.nonce === "string" ? data.nonce : "";
		if (!live || code.spent || pairing.request || !proofMatches(pairProof(code.code, phoneKey, phoneNonce), data.proof)) {
			const reason = pairing.request ? "Another phone is pairing right now" : "This code is no longer valid";
			code.room.send({ type: "data", client, data: { t: "reject", reason } });
			code.room.send({ type: "kick", client });
			if (live && !code.spent && !pairing.request && ++code.failures >= MAX_PAIR_FAILURES) this.rotateCode();
			return;
		}
		code.spent = true;
		// Valid: the code is spent. Stop rotating and drop every other code while this phone finishes.
		clearTimeout(pairing.rotateTimer);
		for (const other of [pairing.current, ...pairing.retiring]) if (other !== code) other.room.close();
		pairing.retiring = [];
		pairing.current = code;
		const name = typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 60) : "Phone";
		const request: PairRequest = {
			id: generateId(),
			name,
			pairing: code,
			client,
			phoneKey,
			phoneNonce,
			timer: setTimeout(() => {
				if (pairing.request !== request) return;
				this.declineRequest(request, "Nobody approved this phone on the computer in time");
				pairing.request = undefined;
				this.rotateCode();
			}, APPROVAL_TIMEOUT_MS),
		};
		pairing.request = request;
		if (this.config.requireApproval) {
			code.room.send({ type: "data", client, data: { t: "waiting" } });
			this.announce();
		} else {
			clearTimeout(request.timer);
			this.completePairing(request);
		}
	}

	private declineRequest(request: PairRequest, reason: string): void {
		clearTimeout(request.timer);
		request.pairing.room.send({ type: "data", client: request.client, data: { t: "reject", reason } });
		request.pairing.room.send({ type: "kick", client: request.client });
	}

	/** Issues the phone its device key, encrypted to this pairing exchange, and closes the pairing window. */
	private completePairing(request: PairRequest): void {
		const pairing = this.pairing;
		if (pairing) pairing.request = undefined;
		const hostKey = ephemeralKey();
		let shared: Buffer;
		try {
			shared = sharedSecret(hostKey, request.phoneKey);
		} catch {
			this.declineRequest(request, "Pairing failed");
			this.stopPairing();
			return;
		}
		const hostNonce = generateNonce();
		const keys = sessionKeys(shared, request.pairing.code, request.phoneNonce, hostNonce);
		const deviceKey = generateDeviceKey();
		const now = Date.now();
		const device: StoredDevice = { id: generateId(), name: request.name, key: deviceKey.toString("base64"), pairedAt: now, lastSeen: now };
		this.config = { ...this.config, devices: [...this.config.devices, device] };
		this.save();
		const grant = JSON.stringify({ seq: 1, hostId: this.config.hostId, deviceId: device.id, deviceKey: device.key, name: hostname() });
		request.pairing.room.send({
			type: "data",
			client: request.client,
			data: {
				t: "paired",
				key: hostKey.publicKey,
				nonce: hostNonce,
				proof: pairedProof(request.pairing.code, request.phoneKey, hostKey.publicKey, request.phoneNonce, hostNonce),
				d: seal(keys.h2c, grant),
			},
		});
		if (pairing) {
			// Stop rotating now; close the room shortly, once the grant has reached the phone.
			clearTimeout(pairing.rotateTimer);
			setTimeout(() => {
				if (this.pairing === pairing) this.stopPairing();
			}, 1000).unref();
		}
		this.announce();
	}

	// ----- Paired phones -----

	private onHostFrame(frame: { type?: string; client?: string; data?: Handshake }): void {
		const client = String(frame.client ?? "");
		if (frame.type === "close") {
			const session = this.sessions.get(client);
			if (!session) return;
			this.sessions.delete(client);
			this.touch(session.deviceId);
			this.announce();
		} else if (frame.type === "data" && frame.data) {
			if (frame.data.t === "hello") this.onHello(client, frame.data);
			else if (frame.data.t === "sealed") this.onSealed(client, frame.data.d);
		}
	}

	private touch(deviceId: string): void {
		this.config = { ...this.config, devices: this.config.devices.map((d) => (d.id === deviceId ? { ...d, lastSeen: Date.now() } : d)) };
		this.save();
	}

	private onHello(client: string, hello: Handshake): void {
		const reject = (reason: string) => {
			this.room?.send({ type: "data", client, data: { t: "reject", reason } });
			this.room?.send({ type: "kick", client });
		};
		const device = this.config.devices.find((d) => d.id === hello.device);
		if (device && device.lastSeen < Date.now() - DEVICE_EXPIRY_MS) {
			this.revoke(device.id);
			return reject("This phone was unused for 30 days and was removed. Pair it again.");
		}
		if (!device) return reject("This phone is no longer paired with the computer. Pair it again.");
		const deviceKey = Buffer.from(device.key, "base64");
		const phoneKey = typeof hello.key === "string" ? hello.key : "";
		const phoneNonce = typeof hello.nonce === "string" ? hello.nonce : "";
		if (!proofMatches(helloProof(deviceKey, device.id, phoneKey, phoneNonce), hello.proof)) return reject("This phone's key was not accepted. Pair it again.");
		const hostKey = ephemeralKey();
		let shared: Buffer;
		try {
			shared = sharedSecret(hostKey, phoneKey);
		} catch {
			return reject("Handshake failed");
		}
		const hostNonce = generateNonce();
		// A repeated hello on the same connection (e.g. after the relay reconnected) replaces the old keys.
		const session: Session = { client, deviceId: device.id, keys: sessionKeys(shared, deviceKey, phoneNonce, hostNonce), sendSeq: 0, recvSeq: 0 };
		this.sessions.set(client, session);
		this.room?.send({
			type: "data",
			client,
			data: {
				t: "welcome",
				key: hostKey.publicKey,
				nonce: hostNonce,
				proof: welcomeProof(deviceKey, phoneKey, hostKey.publicKey, phoneNonce, hostNonce),
				name: hostname(),
			},
		});
		for (const { event, data } of this.hub.stickyEvents()) {
			if (REMOTE_EVENTS.has(event)) this.sendSealed(session, { t: "event", event, data });
		}
		this.touch(device.id);
		this.announce();
	}

	private onSealed(client: string, frame: unknown): void {
		const session = this.sessions.get(client);
		if (!session || typeof frame !== "string") return;
		let message: Inner;
		try {
			message = JSON.parse(open(session.keys.c2h, frame)) as Inner;
		} catch {
			// Undecryptable or tampered: drop the connection rather than guess.
			this.sessions.delete(client);
			this.room?.send({ type: "kick", client });
			this.announce();
			return;
		}
		if (!(message.seq > session.recvSeq)) return;
		session.recvSeq = message.seq;
		if (message.t === "req") void this.onRequest(session, message);
	}

	private async onRequest(session: Session, request: Inner): Promise<void> {
		const method = String(request.method ?? "GET");
		const path = String(request.path ?? "/");
		const pathname = new URL(path, "http://remote").pathname;
		const reply = REMOTE_ROUTES.has(`${method} ${pathname}`)
			? await this.dispatch(method, path, request.body ?? {})
			: { status: 403, body: { error: `${method} ${pathname} is not available remotely` } };
		// The phone may have been revoked while the request ran.
		if (this.sessions.get(session.client) === session) this.sendSealed(session, { t: "res", id: request.id, ...reply });
	}
}
