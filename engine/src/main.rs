//! Sidecar WebSocket cục bộ; stdout chỉ phát một dòng khởi động để Electron bắt cổng/token.

use std::{io::{self, Write}, net::{IpAddr, Ipv4Addr, TcpListener, TcpStream}, path::Path, thread, time::{Duration, Instant}};

use crossbeam_channel::{unbounded, Receiver, Sender, TryRecvError};
use serde::Serialize;
use serde_json::Value;
use tnd_engine::{dsp::{convolution::PartitionedConvolver, EngineProfile}, protocol::{ClientMessage, ServerMessage}, AudioBackend, AudioSessionControl, HotplugWatcher, StartOptions, Telemetry, WasapiCpalBackend};
use tungstenite::{accept, Error as WsError, Message, WebSocket};
use uuid::Uuid;

#[derive(Serialize)]
struct BootMessage { ready: bool, port: u16, token: String, protocol: u32 }

struct PreparedImpulse {
    generation: u64,
    path: String,
    result: Result<PartitionedConvolver, String>,
}

fn main() {
    if let Err(error) = serve() {
        eprintln!("Taylor ND Audio engine stopped: {error}");
        std::process::exit(1);
    }
}

fn serve() -> Result<(), String> {
    serve_with_backend(WasapiCpalBackend)
}

/// Chạy giao thức với backend nào thực hiện hợp đồng audio chung.
fn serve_with_backend<B: AudioBackend>(backend: B) -> Result<(), String> {
    let listener = TcpListener::bind((IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).map_err(|error| format!("Không mở được cổng loopback: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let token = Uuid::new_v4().to_string();
    println!("{}", serde_json::to_string(&BootMessage { ready: true, port, token: token.clone(), protocol: 1 }).map_err(|e| e.to_string())?);
    io::stdout().flush().map_err(|error| error.to_string())?;

    let (stream, _) = listener.accept().map_err(|error| format!("Lỗi chờ kết nối Electron: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(20)));
    let mut socket = accept(stream).map_err(|error| format!("Bắt tay WebSocket thất bại: {error}"))?;
    socket.get_mut().set_read_timeout(Some(Duration::from_millis(20))).map_err(|e| e.to_string())?;
    let auth = match socket.read() {
        Ok(Message::Text(text)) => serde_json::from_str::<ClientMessage>(&text).map_err(|e| format!("Tin xác thực sai định dạng: {e}"))?,
        _ => return Err("Electron chưa gửi xác thực.".into()),
    };
    match auth { ClientMessage::Auth { token: supplied } if supplied == token => {},
        _ => { send_error(&mut socket, "AUTH_FAILED", "Token không hợp lệ.")?; return Err("Từ chối token WebSocket.".into()); } }
    send_ack(&mut socket, "auth", true, "Đã xác thực.")?;

    let hotplug = HotplugWatcher::start();
    let mut session: Option<B::Session> = None;
    let mut profile = EngineProfile::default();
    let mut last_start: Option<StartOptions> = None;
    let mut last_devices = Vec::new();
    let mut last_state_send = Instant::now() - Duration::from_secs(2);
    let mut last_device_scan = Instant::now();
    let mut last_telemetry_send = Instant::now();
    let mut last_telemetry: Option<Telemetry> = None;
    let mut reconnect_pending: Option<(StartOptions, u8, Instant)> = None;
    let mut active_impulse_path = String::new();
    let mut engine_generation = 0u64;
    let mut awaiting_hotplug_reconnect = false;
    let (impulse_tx, impulse_rx) = unbounded::<PreparedImpulse>();

    loop {
        if hotplug.dirty.swap(false, std::sync::atomic::Ordering::Relaxed) {
            last_device_scan = Instant::now() - Duration::from_secs(1);
            if awaiting_hotplug_reconnect && session.is_none() && reconnect_pending.is_none() {
                if let Some(options) = last_start.clone() {
                    reconnect_pending = Some((options, 1, Instant::now() + Duration::from_millis(250)));
                    awaiting_hotplug_reconnect = false;
                }
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let request = match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(value) => value,
                    Err(error) => { send_error(&mut socket, "BAD_MESSAGE", &format!("JSON không hợp lệ: {error}"))?; continue; }
                };
                match request {
                    ClientMessage::Auth { .. } => send_error(&mut socket, "ALREADY_AUTHENTICATED", "Kết nối này đã xác thực.")?,
                    ClientMessage::ListDevices => send_devices(&mut socket, &backend)?,
                    ClientMessage::Start { input_id, output_id, buffer_ms } => {
                        if let Some(mut old) = session.take() { old.stop(); }
                        engine_generation = engine_generation.wrapping_add(1);
                        active_impulse_path.clear();
                        awaiting_hotplug_reconnect = false;
                        let options = StartOptions { input_id, output_id, buffer_ms };
                        match backend.start(options.clone()) {
                            Ok(audio) => {
                                let mut audio = audio;
                                let _ = audio.set_profile(profile.clone());
                                if profile.effects.reverb_enabled && !profile.effects.impulse_path.is_empty() {
                                    active_impulse_path = profile.effects.impulse_path.clone();
                                    schedule_impulse_preparation(&impulse_tx, engine_generation, active_impulse_path.clone(), audio.sample_rate())?;
                                }
                                last_start = Some(options);
                                reconnect_pending = None;
                                session = Some(audio);
                                send_ack(&mut socket, "start", true, "Engine đã khởi chạy.")?;
                                send_state(&mut socket, session.as_ref(), "Đang chạy")?;
                            }
                            Err(error) => {
                                send_error(&mut socket, "DEVICE_START_FAILED", &error)?;
                                send_ack(&mut socket, "start", false, &error)?;
                                send_state(&mut socket, None, &error)?;
                            }
                        }
                    }
                    ClientMessage::Stop => {
                        if let Some(mut audio) = session.take() { audio.stop(); }
                        engine_generation = engine_generation.wrapping_add(1);
                        last_start = None;
                        active_impulse_path.clear();
                        reconnect_pending = None;
                        awaiting_hotplug_reconnect = false;
                        send_ack(&mut socket, "stop", true, "Đã dừng engine và tắt đầu ra an toàn.")?;
                        send_state(&mut socket, None, "Đã dừng")?;
                    }
                    ClientMessage::SetProfile { profile: value } => {
                        match serde_json::from_value::<EngineProfile>(value) {
                            Ok(next) => {
                                profile = next;
                                if let Some(audio) = session.as_ref() {
                                    let _ = audio.set_profile(profile.clone());
                                    if !profile.effects.reverb_enabled || profile.effects.impulse_path.is_empty() {
                                        active_impulse_path.clear();
                                        engine_generation = engine_generation.wrapping_add(1);
                                    } else if active_impulse_path != profile.effects.impulse_path {
                                        active_impulse_path = profile.effects.impulse_path.clone();
                                        schedule_impulse_preparation(&impulse_tx, engine_generation, active_impulse_path.clone(), audio.sample_rate())?;
                                    }
                                }
                                send_ack(&mut socket, "setProfile", true, "Đã cập nhật DSP.")?;
                            }
                            Err(error) => {
                                let message = format!("Hồ sơ không hợp lệ: {error}");
                                send_error(&mut socket, "PROFILE_INVALID", &message)?;
                                send_ack(&mut socket, "setProfile", false, &message)?;
                            }
                        }
                    }
                    ClientMessage::SetBypass { bypass } => {
                        profile.bypass = bypass;
                        if let Some(audio) = session.as_ref() { let _ = audio.set_bypass(bypass); }
                        send_ack(&mut socket, "setBypass", true, if bypass { "Đang bypass." } else { "Đã bật DSP." })?;
                    }
                    ClientMessage::LoadImpulse { path } => {
                        let sample_rate = session.as_ref().map(|audio| audio.sample_rate()).unwrap_or(48_000);
                        if Path::new(&path).extension().and_then(|ext| ext.to_str()).is_none_or(|ext| !ext.eq_ignore_ascii_case("wav")) {
                            send_error(&mut socket, "IR_LOAD_FAILED", "Impulse response phải là file WAV.")?;
                            send_ack(&mut socket, "loadImpulse", false, "Impulse response phải là file WAV.")?;
                        } else {
                            profile.effects.impulse_path = path.clone();
                            profile.effects.reverb_enabled = true;
                            if let Some(audio) = session.as_ref() {
                                let _ = audio.set_profile(profile.clone());
                                engine_generation = engine_generation.wrapping_add(1);
                                active_impulse_path = path.clone();
                                schedule_impulse_preparation(&impulse_tx, engine_generation, path, sample_rate)?;
                            }
                            send_ack(&mut socket, "loadImpulse", true, "Đang chuẩn bị impulse response trên luồng nền.")?;
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(payload)) => { let _ = socket.send(Message::Pong(payload)); }
            Ok(_) => {}
            Err(WsError::Io(error)) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => break,
            Err(error) => return Err(format!("WebSocket đóng do lỗi: {error}")),
        }

        let device_lost = session.as_ref().is_some_and(|audio| audio.device_lost());
        if let Some(audio) = session.as_ref() {
            audio.collect_retired();
            while let Some(report) = audio.next_telemetry() { last_telemetry = Some(report); }
            if last_telemetry_send.elapsed() >= Duration::from_millis(33) {
                if let Some(report) = last_telemetry.as_ref() { send_json(&mut socket, &ServerMessage::Telemetry { data: report })?; }
                last_telemetry_send = Instant::now();
            }
        }
        if device_lost {
            session.take();
            engine_generation = engine_generation.wrapping_add(1);
            active_impulse_path.clear();
            if let Some(options) = last_start.clone() {
                reconnect_pending = Some((options, 1, Instant::now() + Duration::from_millis(250)));
                send_error(&mut socket, "DEVICE_LOST", "Mất thiết bị âm thanh; engine đã tắt tiếng và đang thử kết nối lại.")?;
            }
        }
        if let Some((options, attempt, due)) = reconnect_pending.clone() {
            if Instant::now() >= due {
                match backend.start(options.clone()) {
                    Ok(mut restarted) => {
                        let _ = restarted.set_profile(profile.clone());
                        if profile.effects.reverb_enabled && !profile.effects.impulse_path.is_empty() {
                            active_impulse_path = profile.effects.impulse_path.clone();
                            schedule_impulse_preparation(&impulse_tx, engine_generation, active_impulse_path.clone(), restarted.sample_rate())?;
                        } else {
                            active_impulse_path.clear();
                        }
                        session = Some(restarted);
                        reconnect_pending = None;
                        send_error(&mut socket, "DEVICE_RECONNECTED", "Thiết bị đã kết nối lại; âm thanh đang fade-in.")?;
                    }
                    Err(error) => {
                        send_error(&mut socket, "DEVICE_RECONNECT_FAILED", &format!("Thử kết nối lại {attempt}/3: {error}"))?;
                        if attempt >= 3 {
                            reconnect_pending = None;
                            awaiting_hotplug_reconnect = true;
                            send_error(&mut socket, "FALLBACK_SUGGESTED", "Không kết nối lại được sau 3 lần. Engine đang tắt tiếng; hãy kiểm tra thiết bị hoặc chuyển về Equalizer APO.")?;
                        } else {
                            reconnect_pending = Some((options, attempt + 1, Instant::now() + Duration::from_millis(500)));
                        }
                    }
                }
            }
        }
        if last_device_scan.elapsed() >= Duration::from_secs(1) {
            if let Ok(devices) = backend.enumerate() {
                let changed = devices.iter().map(|d| (&d.id, &d.name, &d.direction, d.channels, d.sample_rate)).collect::<Vec<_>>()
                    != last_devices.iter().map(|d: &tnd_engine::DeviceInfo| (&d.id, &d.name, &d.direction, d.channels, d.sample_rate)).collect::<Vec<_>>();
                if changed {
                    last_devices = devices;
                    send_devices(&mut socket, &backend)?;
                    if awaiting_hotplug_reconnect && session.is_none() && reconnect_pending.is_none() {
                        if let Some(options) = last_start.clone() {
                            reconnect_pending = Some((options, 1, Instant::now() + Duration::from_millis(250)));
                            awaiting_hotplug_reconnect = false;
                        }
                    }
                }
            }
            last_device_scan = Instant::now();
        }
        while let Ok(prepared) = impulse_rx.try_recv() {
            if prepared.generation != engine_generation || prepared.path != profile.effects.impulse_path { continue; }
            match prepared.result {
                Ok(convolver) if profile.effects.reverb_enabled => {
                    if let Some(audio) = session.as_ref() { let _ = audio.set_impulse(convolver); }
                }
                Ok(_) => {}
                Err(error) => send_error(&mut socket, "IR_LOAD_FAILED", &error)?,
            }
        }
        if last_state_send.elapsed() >= Duration::from_millis(500) {
            send_state(&mut socket, session.as_ref(), if session.is_some() { "Đang chạy" } else { "Đã dừng" })?;
            last_state_send = Instant::now();
        }
    }
    if let Some(mut audio) = session.take() { audio.stop(); }
    Ok(())
}

struct DspImpulse;
impl DspImpulse {
    fn load(path: &str, sample_rate: u32) -> Result<PartitionedConvolver, String> {
        if path.len() > 2048 || path.chars().any(|character| matches!(character, '\r' | '\n' | '\0')) { return Err("Đường dẫn IR không hợp lệ.".into()); }
        if Path::new(path).extension().and_then(|ext| ext.to_str()).is_none_or(|ext| !ext.eq_ignore_ascii_case("wav")) {
            return Err("Impulse response phải là file WAV.".into());
        }
        tnd_engine::Dsp::prepare_impulse(Path::new(path), sample_rate).map(PartitionedConvolver::new)
    }
}

/// Đọc WAV, phân vùng FFT và cấp phát bộ nhớ IR ngoài worker xử lý audio.
fn schedule_impulse_preparation(sender: &Sender<PreparedImpulse>, generation: u64, path: String, sample_rate: u32) -> Result<(), String> {
    let result_sender = sender.clone();
    thread::Builder::new().name("Taylor IR preparation".into()).spawn(move || {
        let result = DspImpulse::load(&path, sample_rate);
        let _ = result_sender.send(PreparedImpulse { generation, path, result });
    }).map(|_| ()).map_err(|error| format!("Không tạo được luồng chuẩn bị IR: {error}"))
}

fn send_devices(socket: &mut WebSocket<TcpStream>, backend: &impl AudioBackend) -> Result<(), String> {
    let devices = backend.enumerate()?;
    let cable_detected = devices.iter().any(|device| device.name.to_ascii_lowercase().contains("cable input"))
        && devices.iter().any(|device| device.name.to_ascii_lowercase().contains("cable output"));
    send_json(socket, &ServerMessage::Devices { devices: &devices, cable_detected })
}

fn send_state<S: AudioSessionControl>(socket: &mut WebSocket<TcpStream>, session: Option<&S>, message: &str) -> Result<(), String> {
    let state = match session {
        Some(audio) => StateOwned::new(true, audio.sample_rate(), audio.latency_ms(), audio.xruns(), message),
        None => StateOwned::new(false, 0, 0.0, 0, message),
    };
    send_json(socket, &state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateOwned<'a> { #[serde(rename = "type")] kind: &'static str, running: bool, sample_rate: u32, latency_ms: f32, xruns: u64, message: &'a str }

impl<'a> StateOwned<'a> {
    fn new(running: bool, sample_rate: u32, latency_ms: f32, xruns: u64, message: &'a str) -> Self {
        Self { kind: "state", running, sample_rate, latency_ms, xruns, message }
    }
}

fn send_error(socket: &mut WebSocket<TcpStream>, code: &str, message: &str) -> Result<(), String> {
    send_json(socket, &ServerMessage::Error { code, message })
}
fn send_ack(socket: &mut WebSocket<TcpStream>, request: &str, ok: bool, message: &str) -> Result<(), String> {
    send_json(socket, &ServerMessage::Ack { request, ok, message })
}
fn send_json<T: Serialize>(socket: &mut WebSocket<TcpStream>, message: &T) -> Result<(), String> {
    let text = serde_json::to_string(message).map_err(|error| error.to_string())?;
    socket.send(Message::Text(text)).map_err(|error| format!("Không gửi được IPC: {error}"))
}
