import { Copy, Smartphone, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { api, serverEvents } from "../api.ts";
import { relativeTime } from "../format.ts";
import { Setting, Switch, TextField } from "./Pages.tsx";

/** GET /api/remote (server/remote.ts). */
interface RemoteStatus {
	enabled: boolean;
	relayUrl: string;
	requireApproval: boolean;
	relay: "off" | "connecting" | "online" | "error";
	error?: string;
	devices: { id: string; name: string; pairedAt: number; lastSeen: number; connected: boolean }[];
	pairing?: { code: string; pairUrl: string; codeExpiresAt: number; endsAt: number; request?: { id: string; name: string } };
}

const RELAY_LABEL: Record<RemoteStatus["relay"], string> = {
	off: "Off",
	connecting: "Connecting to the relay…",
	online: "Connected to the relay",
	error: "Relay unreachable",
};

/** The pairing link as an SVG QR code, drawn from uqr's module matrix. */
function QrCode({ text }: { text: string }) {
	const path = useMemo(() => {
		const { data } = encode(text, { ecc: "M", border: 2 });
		let d = "";
		data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
		return { d, size: data.length };
	}, [text]);
	return (
		<svg className="remote-qr" viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
			<rect width={path.size} height={path.size} fill="#fff" />
			<path d={path.d} fill="#000" />
		</svg>
	);
}

function countdown(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

/** The open pairing window: a one-time code that changes every minute, or a phone waiting for approval. */
function PairingPanel({ pairing, update }: { pairing: NonNullable<RemoteStatus["pairing"]>; update: (request: Promise<RemoteStatus>) => void }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const cancel = (
		<button type="button" className="btn-ghost" onClick={() => update(api("POST", "/api/remote/pair/stop"))}>
			<X size={14} />
			Cancel
		</button>
	);
	if (pairing.request) {
		const { id, name } = pairing.request;
		return (
			<div className="remote-request" role="alertdialog" aria-label="Pairing request">
				<Smartphone size={20} />
				<div className="remote-pair-info">
					<div className="label">
						<b>{name}</b> wants to control Sorvex on this computer.
					</div>
					<small>Only allow it if this is your phone and you just scanned the code.</small>
					<div className="remote-actions">
						<button type="button" className="btn-accent" onClick={() => update(api("POST", "/api/remote/pair/answer", { id, allow: true }))}>
							Allow
						</button>
						<button type="button" className="btn-ghost" onClick={() => update(api("POST", "/api/remote/pair/answer", { id, allow: false }))}>
							Deny
						</button>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="remote-pair">
			<QrCode text={pairing.pairUrl} />
			<div className="remote-pair-info">
				<div className="label">Scan with your phone's camera, or enter this code in Sorvex Browser:</div>
				<div className="remote-code mono">{pairing.code}</div>
				<small>
					This code works for one phone only. It changes in {countdown(pairing.codeExpiresAt - now)}; pairing closes in {countdown(pairing.endsAt - now)}.
				</small>
				<div className="remote-actions">
					<button type="button" className="btn-ghost" onClick={() => void navigator.clipboard.writeText(pairing.code)}>
						<Copy size={14} />
						Copy code
					</button>
					{cancel}
				</div>
			</div>
		</div>
	);
}

/** Settings → Remote access: pair phones through the Sorvex-Browser relay and manage them. */
export function RemoteSection({ toast }: { toast: (kind: "info" | "error", text: string) => void }) {
	const [status, setStatus] = useState<RemoteStatus>();

	useEffect(() => {
		void api<RemoteStatus>("GET", "/api/remote").then(setStatus).catch(() => undefined);
		return serverEvents.on<RemoteStatus>("remote", setStatus);
	}, []);

	const update = (request: Promise<RemoteStatus>) =>
		void request.then(setStatus).catch((error: unknown) => toast("error", error instanceof Error ? error.message : String(error)));

	if (!status) return null;
	const online = status.enabled && status.relay === "online";
	const connected = status.devices.filter((device) => device.connected).length;
	return (
		<section className="card">
			<h2>Remote access</h2>
			<p>Control this computer's Sorvex from your phone. Sorvex Desktop must stay running.</p>
			<Setting label="Remote access" hint="Phones connect through the relay, end-to-end encrypted.">
				<Switch on={status.enabled} label="Remote access" onChange={(enabled) => update(api("PUT", "/api/remote", { enabled }))} />
			</Setting>
			<Setting label="Relay URL" hint="The Sorvex-Browser relay your phone can reach">
				<TextField value={status.relayUrl} placeholder="https://sorvex.example.com" onChange={(relayUrl) => update(api("PUT", "/api/remote", { relayUrl }))} />
			</Setting>
			<Setting label="Confirm new phones" hint="Ask here before a phone that scanned the code is paired">
				<Switch
					on={status.requireApproval}
					label="Confirm new phones"
					onChange={(requireApproval) => update(api("PUT", "/api/remote", { requireApproval }))}
				/>
			</Setting>
			{status.enabled && (
				<>
					<Setting label="Status" hint={status.error}>
						<span className={`remote-status ${connected > 0 && online ? "live" : status.relay}`}>
							<span className="remote-dot" />
							{connected > 0 && online ? `${connected} phone${connected > 1 ? "s" : ""} connected` : RELAY_LABEL[status.relay]}
						</span>
					</Setting>
					{status.pairing ? (
						<PairingPanel pairing={status.pairing} update={update} />
					) : (
						<Setting label="Pair a phone" hint="Shows a one-time code. Each phone needs its own code.">
							<button type="button" className="btn-accent" disabled={!online} onClick={() => update(api("POST", "/api/remote/pair/start"))}>
								<Smartphone size={14} />
								Pair a phone
							</button>
						</Setting>
					)}
				</>
			)}
			{status.devices.length > 0 && (
				<div className="remote-devices">
					<div className="remote-devices-head">
						<span>Paired phones</span>
						{status.devices.length > 1 && (
							<button
								type="button"
								className="btn-ghost"
								onClick={() => window.confirm("Remove every paired phone? Each will need a new code.") && update(api("POST", "/api/remote/revoke-all"))}
							>
								Remove all
							</button>
						)}
					</div>
					{status.devices.map((device) => (
						<Setting
							key={device.id}
							label={device.name}
							hint={`${device.connected ? "Connected now" : `Last seen ${relativeTime(device.lastSeen)}`} · paired ${new Date(device.pairedAt).toLocaleDateString()}`}
						>
							<button
								type="button"
								className="btn-ghost"
								onClick={() => window.confirm(`Remove ${device.name}? It will need a new code to connect again.`) && update(api("POST", "/api/remote/revoke", { id: device.id }))}
							>
								Remove
							</button>
						</Setting>
					))}
				</div>
			)}
		</section>
	);
}
