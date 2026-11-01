import { Check, Download, ExternalLink, Loader2, Plus, RefreshCw, RotateCw, Smartphone, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, serverEvents } from "../api.ts";
import { DeviceStage } from "./DeviceStage.tsx";
import { PaneFrame, PaneHeader } from "./PaneFrame.tsx";
import { Select } from "./Select.tsx";

interface SetupState {
	running: boolean;
	step: string;
	message: string;
	percent: number | null;
	error: string | null;
	log: string[];
}

interface DeviceStatus {
	sdk: { root: string | null; adb: string | null; emulator: string | null; sdkmanager: string | null; avdmanager: string | null; systemImages: string[] };
	java: { path: string; version: number } | null;
	kvm: { ok: boolean; message?: string };
	avds: string[];
	missing: string[];
	ready: boolean;
	setup: SetupState;
	hub: { installed: boolean; running: boolean; starting: boolean; port: number | null; token: string | null; error: string | null };
}

const LICENSE_URL = "https://developer.android.com/studio/terms";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the setup checklist shows, in install order. */
function checklist(status: DeviceStatus): { label: string; done: boolean; detail?: string }[] {
	const hasAvd = status.avds.length > 0;
	return [
		{ label: "Java 17 or newer", done: Boolean(status.java) || hasAvd, detail: status.java ? `Java ${status.java.version}` : hasAvd ? "not needed" : "Temurin 21 is downloaded" },
		{ label: "SDK command-line tools", done: Boolean(status.sdk.sdkmanager) || hasAvd },
		{ label: "Platform-tools (adb)", done: Boolean(status.sdk.adb) },
		{ label: "Android Emulator", done: Boolean(status.sdk.emulator) },
		{
			label: "System image",
			done: status.sdk.systemImages.length > 0 || hasAvd,
			detail: status.sdk.systemImages.length > 0 ? status.sdk.systemImages.at(-1)?.replace("system-images;", "") : "newest Google APIs image",
		},
		{ label: "Virtual device", done: hasAvd, detail: hasAvd ? status.avds.join(", ") : "Sorvex_Pixel" },
	];
}

function Setup({ status, onStart }: { status: DeviceStatus; onStart: (accept: boolean) => void }) {
	const [accepted, setAccepted] = useState(false);
	const { setup } = status;
	const fresh = !status.sdk.root;
	const items = checklist(status);
	return (
		<div className="device-setup">
			<h2>Android emulator</h2>
			<p>
				{fresh
					? "No Android SDK was found. Sorvex can download it and create a virtual device, about 2 GB."
					: "Some parts of the Android SDK are missing. Sorvex can install them into the SDK below."}
			</p>
			<ul className="device-checklist">
				{items.map((item) => (
					<li key={item.label} className={item.done ? "done" : ""}>
						<span className="device-check">{item.done ? <Check size={12} /> : null}</span>
						<span>{item.label}</span>
						{item.detail && <small>{item.detail}</small>}
					</li>
				))}
			</ul>
			<div className="device-path">
				<span>SDK location</span>
				<code>{status.sdk.root ?? "~/Android/Sdk (new)"}</code>
			</div>
			{!status.kvm.ok && (
				<div className="device-warning">
					<TriangleAlert size={14} /> {status.kvm.message}
				</div>
			)}
			{setup.running ? (
				<div className="device-progress">
					<div className="device-progress-head">
						<Loader2 size={13} className="spin" />
						<span>{setup.step}</span>
						{setup.percent !== null && <span className="device-progress-pct">{setup.percent}%</span>}
					</div>
					<div className="device-progress-track">
						<div className={setup.percent === null ? "indeterminate" : ""} style={setup.percent === null ? undefined : { width: `${setup.percent}%` }} />
					</div>
					<div className="device-progress-msg">{setup.message}</div>
				</div>
			) : (
				<>
					{setup.error && <div className="device-error">{setup.error}</div>}
					<label className="device-license">
						<input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
						<span>
							I have read and accept the{" "}
							<button type="button" className="device-link" onClick={() => void api("POST", "/api/open", { url: LICENSE_URL })}>
								Android SDK License Agreement <ExternalLink size={11} />
							</button>
						</span>
					</label>
					<button type="button" className="btn-accent" disabled={!accepted} onClick={() => onStart(accepted)}>
						<Download size={14} /> {fresh ? "Download and install" : setup.error ? "Retry" : "Install missing parts"}
					</button>
				</>
			)}
			{setup.log.length > 0 && (
				<details className="device-log">
					<summary>Details</summary>
					<pre>{setup.log.join("\n")}</pre>
				</details>
			)}
		</div>
	);
}

interface AvdInfo {
	name: string;
	displayName: string;
	api: number | null;
	version: string | null;
	device: string | null;
	serial: string | null;
}

interface SystemImage {
	path: string;
	api: number;
	version: string;
	tag: string;
	abi: string;
}

const PROFILE_NAMES: Record<string, string> = { medium_phone: "Medium phone", small_phone: "Small phone", medium_tablet: "Medium tablet", resizable: "Resizable" };
const profileName = (id: string) => PROFILE_NAMES[id] ?? id.replace(/^pixel/, "Pixel").replace(/_/g, " ").replace(/\b(pro|xl|fold|tablet)\b/g, (word) => word[0]!.toUpperCase() + word.slice(1));

/** Emulators on this machine, each with Start or Stop, like a device list in Android Studio. */
function DeviceList({ avds, busy, onStart, onStop, onRefresh, onAdd }: {
	avds: AvdInfo[];
	busy: string | null;
	onStart: (avd: string) => void;
	onStop: (serial: string) => void;
	onRefresh: () => void;
	onAdd: () => void;
}) {
	return (
		<div className="device-list">
			<div className="device-list-head">
				<Smartphone size={14} />
				<span>Android emulators</span>
				<button type="button" className="icon-btn sm" title="Add an emulator" aria-label="Add an emulator" onClick={onAdd}>
					<Plus size={14} />
				</button>
			</div>
			{avds.map((avd) => (
				<div key={avd.name} className="device-row">
					<span className="device-row-icon">
						<Smartphone size={15} />
					</span>
					<span className="device-row-text">
						<span>{avd.displayName}</span>
						<small>{["This machine", avd.version, busy === avd.name ? "Starting" : avd.serial ? "Running" : "Stopped"].filter(Boolean).join(" · ")}</small>
					</span>
					{avd.serial ? (
						<button type="button" className="btn-ghost device-row-btn" onClick={() => onStop(avd.serial!)}>
							Stop
						</button>
					) : (
						<button type="button" className="btn-ghost device-row-btn" disabled={busy !== null} onClick={() => onStart(avd.name)}>
							{busy === avd.name ? <Loader2 size={13} className="spin" /> : "Start"}
						</button>
					)}
				</div>
			))}
			{avds.length === 0 && (
				<div className="device-list-empty">
					No virtual devices yet.
					<button type="button" className="btn-accent" onClick={onAdd}>
						<Plus size={14} /> Create an emulator
					</button>
				</div>
			)}
			<button type="button" className="device-refresh" onClick={onRefresh}>
				<RefreshCw size={12} /> Refresh devices
			</button>
		</div>
	);
}

/** The + dialog: start an existing emulator, or create one from an installed system image (downloading one if needed). */
function AddEmulator({ avds, setup, busy, onStart, onClose, toast }: {
	avds: AvdInfo[];
	setup: SetupState;
	busy: string | null;
	onStart: (avd: string) => void;
	onClose: () => void;
	toast: (kind: "info" | "error", text: string) => void;
}) {
	const [options, setOptions] = useState<{ images: SystemImage[]; profiles: string[]; sdkReady: boolean } | null>(null);
	const [latest, setLatest] = useState<SystemImage | null | undefined>(undefined);
	const [image, setImage] = useState("");
	const [profile, setProfile] = useState("");
	const [name, setName] = useState("");
	const [accepted, setAccepted] = useState(false);
	const [creating, setCreating] = useState(false);

	const load = useCallback(() => {
		void api<{ images: SystemImage[]; profiles: string[]; sdkReady: boolean }>("GET", "/api/device/new-options").then((result) => {
			setOptions(result);
			setImage((current) => current || result.images[0]?.path || "");
			setProfile((current) => current || (result.profiles.includes("pixel_7") ? "pixel_7" : (result.profiles.find((id) => id.startsWith("pixel")) ?? "")));
		}, (error: unknown) => toast("error", errorText(error)));
		void api<{ image: SystemImage | null }>("GET", "/api/device/latest-image").then((result) => setLatest(result.image), () => setLatest(null));
	}, [toast]);
	useEffect(load, [load]);
	// A finished image download refreshes the list of images.
	const wasRunning = useRef(setup.running);
	useEffect(() => {
		if (wasRunning.current && !setup.running) load();
		wasRunning.current = setup.running;
	}, [setup.running, load]);

	const chosen = options?.images.find((entry) => entry.path === image);
	const defaultName = chosen ? `${profileName(profile || "device").replace(/\s+/g, "_")}_API_${chosen.api}` : "";
	const newer = latest && !options?.images.some((entry) => entry.api >= latest.api) ? latest : null;

	const create = () => {
		setCreating(true);
		void api("POST", "/api/device/create", { name: (name.trim() || defaultName).replace(/\s+/g, "_"), image, profile })
			.then(
				() => {
					toast("info", "Emulator created; it is starting");
					onClose();
				},
				(error: unknown) => toast("error", errorText(error)),
			)
			.finally(() => setCreating(false));
	};

	return (
		<div className="device-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div className="device-dialog" role="dialog" aria-modal="true" aria-label="Add an emulator">
				<div className="device-dialog-head">
					<span>Add an emulator</span>
					<button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}>
						<X size={14} />
					</button>
				</div>
				<div className="device-dialog-body">
					{avds.length > 0 && (
						<section>
							<h3>Your emulators</h3>
							{avds.map((avd) => (
								<div key={avd.name} className="device-row compact">
									<span className="device-row-icon">
										<Smartphone size={14} />
									</span>
									<span className="device-row-text">
										<span>{avd.displayName}</span>
										<small>{[avd.version, avd.device && profileName(avd.device), avd.serial ? "Running" : null].filter(Boolean).join(" · ")}</small>
									</span>
									{!avd.serial && (
										<button
											type="button"
											className="btn-ghost device-row-btn"
											disabled={busy !== null}
											onClick={() => {
												onStart(avd.name);
												onClose();
											}}
										>
											Start
										</button>
									)}
								</div>
							))}
						</section>
					)}
					<section>
						<h3>New emulator</h3>
						{!options ? (
							<div className="device-center small">
								<Loader2 size={14} className="spin" />
							</div>
						) : !options.sdkReady ? (
							<p className="device-note">Set up the Android SDK first.</p>
						) : (
							<>
								{options.images.length > 0 ? (
									<div className="device-form">
										<label>
											<span>System image</span>
											<Select
												width="100%"
												ariaLabel="System image"
												value={image}
												options={options.images.map((entry) => ({ value: entry.path, label: `${entry.version} (API ${entry.api})`, hint: `${entry.tag} ${entry.abi}` }))}
												onChange={setImage}
											/>
										</label>
										<label>
											<span>Device</span>
											<Select
												width="100%"
												searchable
												ariaLabel="Device profile"
												value={profile}
												options={options.profiles.map((id) => ({ value: id, label: profileName(id) }))}
												onChange={setProfile}
											/>
										</label>
										<label>
											<span>Name</span>
											<input className="modal-input" placeholder={defaultName} value={name} onChange={(event) => setName(event.target.value)} />
										</label>
									</div>
								) : (
									<p className="device-note">No usable system image is installed yet.</p>
								)}
								{newer && (
									<div className="device-download">
										{setup.running ? (
											<div className="device-progress">
												<div className="device-progress-head">
													<Loader2 size={13} className="spin" />
													<span>{setup.step}</span>
													{setup.percent !== null && <span className="device-progress-pct">{setup.percent}%</span>}
												</div>
												<div className="device-progress-track">
													<div className={setup.percent === null ? "indeterminate" : ""} style={setup.percent === null ? undefined : { width: `${setup.percent}%` }} />
												</div>
												<div className="device-progress-msg">{setup.message}</div>
											</div>
										) : (
											<>
												<span>
													{newer.version} (API {newer.api}) is available, about 1.5 GB.
												</span>
												{setup.error && <div className="device-error">{setup.error}</div>}
												<label className="device-license">
													<input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
													<span>
														I accept the{" "}
														<button type="button" className="device-link" onClick={() => void api("POST", "/api/open", { url: LICENSE_URL })}>
															Android SDK License Agreement <ExternalLink size={11} />
														</button>
													</span>
												</label>
												<button
													type="button"
													className="btn-ghost"
													disabled={!accepted}
													onClick={() => void api("POST", "/api/device/install-image", { image: newer.path, acceptLicense: accepted }).catch((error: unknown) => toast("error", errorText(error)))}
												>
													<Download size={13} /> Download {newer.version}
												</button>
											</>
										)}
									</div>
								)}
							</>
						)}
					</section>
				</div>
				<div className="device-dialog-foot">
					<button type="button" className="btn-ghost" onClick={onClose}>
						Cancel
					</button>
					<button type="button" className="btn-accent" disabled={!image || !options?.images.length || creating} onClick={create}>
						{creating ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Create and start
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * Android emulators, next to the Browser pane. Sets up the SDK when it is missing, lists the emulators on this
 * machine, and shows the running one: Expo Device Hub's stream with touch and keyboard input, a controls rail, and
 * live CPU, memory and network graphs. The agent drives the same device with the device_* tools.
 */
export function DevicePane({
	hidden,
	expanded,
	onToggleExpand,
	width,
	onResize,
	onClose,
	toast,
}: {
	hidden: boolean;
	expanded: boolean;
	onToggleExpand: () => void;
	width: number;
	onResize: (width: number) => void;
	onClose: () => void;
	toast: (kind: "info" | "error", text: string) => void;
}) {
	const [status, setStatus] = useState<DeviceStatus | null>(null);
	const [hubState, setHubState] = useState<string>("");
	const [avds, setAvds] = useState<AvdInfo[] | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [booting, setBooting] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const starting = useRef(false);

	const refresh = useCallback(() => {
		void api<DeviceStatus>("GET", "/api/device/status").then(setStatus, (error: unknown) => toast("error", errorText(error)));
	}, [toast]);
	const refreshDevices = useCallback(() => {
		void api<{ avds: AvdInfo[] }>("GET", "/api/device/list").then((result) => setAvds(result.avds), () => undefined);
	}, []);

	useEffect(() => {
		refresh();
		const offSetup = serverEvents.on<SetupState>("device-setup", (setup) => {
			setStatus((current) => (current ? { ...current, setup } : current));
			if (!setup.running) refresh();
		});
		const offHub = serverEvents.on<{ state: string; error?: string | null }>("device-hub", (event) => {
			setHubState(event.state);
			if (event.state === "running" || event.state === "stopped") refresh();
		});
		return () => {
			offSetup();
			offHub();
		};
	}, [refresh]);

	const startHub = useCallback(
		(restart = false) => {
			if (starting.current) return;
			starting.current = true;
			void api<DeviceStatus>("POST", restart ? "/api/device/hub/restart" : "/api/device/hub/start")
				.then(setStatus, (error: unknown) => {
					toast("error", `Device hub: ${errorText(error)}`);
					refresh();
				})
				.finally(() => {
					starting.current = false;
				});
		},
		[toast, refresh],
	);

	const ready = status?.ready ?? false;
	const running = status?.hub.running ?? false;
	const hubError = status?.hub.error;
	useEffect(() => {
		if (!hidden && ready && !running && !hubError) startHub();
	}, [hidden, ready, running, hubError, startHub]);

	// The device list follows emulators started or stopped elsewhere (the agent, Android Studio) while the pane shows.
	useEffect(() => {
		if (hidden || !ready) return;
		refreshDevices();
		const timer = setInterval(refreshDevices, 4000);
		return () => clearInterval(timer);
	}, [hidden, ready, refreshDevices]);

	const runningAvds = (avds ?? []).filter((avd) => avd.serial);
	const current = runningAvds.find((avd) => avd.serial === selected) ?? runningAvds[0];
	useEffect(() => {
		if (booting && avds?.some((avd) => avd.name === booting && avd.serial)) {
			setSelected(avds.find((avd) => avd.name === booting)!.serial);
			setBooting(null);
		}
	}, [avds, booting]);

	const start = (avd: string) => {
		setBooting(avd);
		void api("POST", "/api/device/boot", { avd }).then(refreshDevices, (error: unknown) => {
			setBooting(null);
			toast("error", errorText(error));
		});
	};
	const stop = (serial: string) => void api("POST", "/api/device/shutdown", { serial }).then(refreshDevices, (error: unknown) => toast("error", errorText(error)));

	const hub = status?.hub;
	let body: ReactNode;
	if (!status) {
		body = (
			<div className="device-center">
				<Loader2 size={16} className="spin" />
			</div>
		);
	} else if (!status.ready || (status.setup.running && !adding)) {
		body = (
			<Setup
				status={status}
				onStart={(accept) => void api("POST", "/api/device/setup", { acceptLicense: accept }).then(refresh, (error: unknown) => toast("error", errorText(error)))}
			/>
		);
	} else if (hub?.error && !hub.running) {
		body = (
			<div className="device-center">
				<div className="device-error">{hub.error}</div>
				<button type="button" className="btn-ghost" onClick={() => startHub(true)}>
					<RotateCw size={13} /> Try again
				</button>
			</div>
		);
	} else if (!hub?.running || !hub.port || !hub.token || !avds) {
		body = (
			<div className="device-center">
				<Loader2 size={16} className="spin" />
				<span>{hubState === "installing" || !hub?.installed ? "Installing Device Hub (first run only)" : "Starting Device Hub"}</span>
			</div>
		);
	} else if (current?.serial) {
		body = (
			<DeviceStage
				key={current.serial}
				serial={current.serial}
				name={current.displayName}
				port={hub.port}
				token={hub.token}
				onToggleExpand={onToggleExpand}
				onShutDown={() => stop(current.serial!)}
				// The full-window pane hides the composer; step back so the user can write the prompt.
				onAttached={() => expanded && onToggleExpand()}
				toast={toast}
			/>
		);
	} else {
		body = <DeviceList avds={avds} busy={booting} onStart={start} onStop={stop} onRefresh={refreshDevices} onAdd={() => setAdding(true)} />;
	}

	return (
		<PaneFrame expanded={expanded} width={width} onResize={onResize} hidden={hidden} className="device-pane">
			<PaneHeader
				expanded={expanded}
				onToggleExpand={onToggleExpand}
				onClose={onClose}
				actions={
					status?.ready && (
						<>
							<button type="button" className="icon-btn sm" title="Add an emulator" aria-label="Add an emulator" onClick={() => setAdding(true)}>
								<Plus size={14} />
							</button>
							<button type="button" className="icon-btn sm" title="Restart Device Hub" aria-label="Restart Device Hub" onClick={() => startHub(true)}>
								<RotateCw size={13} />
							</button>
						</>
					)
				}
			>
				<Smartphone size={14} />
				{runningAvds.length > 1 && current ? (
					<Select
						width={200}
						ariaLabel="Running device"
						value={current.serial!}
						options={runningAvds.map((avd) => ({ value: avd.serial!, label: avd.displayName, hint: avd.version ?? undefined }))}
						onChange={setSelected}
					/>
				) : (
					<span className="pane-title">{current ? current.displayName : "Device"}</span>
				)}
				{current?.version && runningAvds.length <= 1 && !current.displayName.includes(current.version.replace("Android ", "")) && (
					<span className="pane-subtitle">{current.version}</span>
				)}
			</PaneHeader>
			<div className="device-body">{body}</div>
			{adding && status && <AddEmulator avds={avds ?? []} setup={status.setup} busy={booting} onStart={start} onClose={() => setAdding(false)} toast={toast} />}
		</PaneFrame>
	);
}
