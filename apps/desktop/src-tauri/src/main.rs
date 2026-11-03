#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Thin desktop shell, the same shape as warpdrv's: start the Node server (apps/desktop/server), then show the
//! UI. In development the window loads the Vite dev server, which proxies /api to the Node server. In a release
//! build the window navigates to the Node server, which also serves the built UI.
//!
//! An installed app (see scripts/build-windows.sh) ships node, the bundled server and the Sorvex binary as
//! resources; a release build without them runs the server from the checkout it was built in.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{Manager, RunEvent};

struct Server(Mutex<Option<Child>>);

fn port() -> u16 {
	std::env::var("SORVEX_DESKTOP_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(4517)
}

fn is_listening(port: u16) -> bool {
	TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(200)).is_ok()
}

/// `node --import <source-resolver> apps/desktop/server/index.ts`, from the checkout this app was built in.
fn spawn_server(port: u16) -> Option<Child> {
	let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().ok()?;
	let resolver = root.join("packages/coding-agent/src/experimental/source-resolver.ts");
	let server = root.join("apps/desktop/server/index.ts");
	Command::new("node")
		.arg("--import")
		.arg(format!("file://{}", resolver.display()))
		.arg(server)
		.current_dir(&root)
		.env("SORVEX_DESKTOP_PORT", port.to_string())
		.spawn()
		.map_err(|error| eprintln!("[sorvex-desktop] failed to start server: {error}"))
		.ok()
}

/// `node server/index.mjs` from the installed resources, with the bundled Sorvex binary as the agent.
fn spawn_bundled_server(resources: &Path, port: u16) -> Option<Child> {
	let server = resources.join("server").join("index.mjs");
	if !server.exists() {
		return None;
	}
	let exe = if cfg!(windows) { ".exe" } else { "" };
	let mut command = Command::new(resources.join("node").join(format!("node{exe}")));
	command
		.arg(server)
		.current_dir(resources)
		.env("SORVEX_DESKTOP_PORT", port.to_string())
		.env("SORVEX_DESKTOP_BIN", resources.join("sorvex").join(format!("sorvex{exe}")));
	// Without this a console window opens next to the app; processes the server starts share the hidden console.
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		const CREATE_NO_WINDOW: u32 = 0x0800_0000;
		command.creation_flags(CREATE_NO_WINDOW);
	}
	command.spawn().map_err(|error| eprintln!("[sorvex-desktop] failed to start bundled server: {error}")).ok()
}

/// Lets the webview use the microphone for dictation. Only user-media requests are granted.
#[cfg(target_os = "linux")]
fn allow_microphone(window: &tauri::WebviewWindow) {
	use webkit2gtk::glib::prelude::Cast;
	use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};

	let _ = window.with_webview(|webview| {
		let view = webview.inner();
		if let Some(settings) = WebViewExt::settings(&view) {
			settings.set_enable_media_stream(true);
			settings.set_media_playback_requires_user_gesture(false);
		}
		view.connect_permission_request(|_, request| {
			let is_media = request.downcast_ref::<UserMediaPermissionRequest>().is_some();
			if is_media {
				request.allow();
			}
			is_media
		});
	});
}

fn main() {
	// WebKitGTK's DMA-BUF renderer crashes in Mesa's GBM teardown on some Linux drivers when the window
	// closes. The fallback renderer avoids that path. Respect an explicit setting from the user.
	#[cfg(target_os = "linux")]
	if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
		std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
	}

	let port = port();

	let app = tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.setup(move |app| {
			// Reuse a server that is already running, e.g. one started by `npm run dev`.
			let child = if is_listening(port) {
				None
			} else {
				let resources: Option<PathBuf> = if cfg!(debug_assertions) { None } else { app.path().resource_dir().ok() };
				resources.and_then(|dir| spawn_bundled_server(&dir, port)).or_else(|| spawn_server(port))
			};
			app.manage(Server(Mutex::new(child)));
			let window = app.get_webview_window("main").expect("main window");
			#[cfg(target_os = "linux")]
			allow_microphone(&window);
			if !cfg!(debug_assertions) {
				thread::spawn(move || {
					// A first launch on Windows can be slow while antivirus scans node and the server bundle.
					for _ in 0..300 {
						if is_listening(port) {
							break;
						}
						thread::sleep(Duration::from_millis(100));
					}
					if let Ok(url) = format!("http://127.0.0.1:{port}").parse() {
						let _ = window.navigate(url);
					}
				});
			}
			Ok(())
		})
		.build(tauri::generate_context!())
		.expect("failed to build Sorvex desktop");

	app.run(|handle, event| {
		if let RunEvent::Exit = event {
			if let Some(mut child) = handle.state::<Server>().0.lock().ok().and_then(|mut guard| guard.take()) {
				let _ = child.kill();
			}
		}
	});
}
