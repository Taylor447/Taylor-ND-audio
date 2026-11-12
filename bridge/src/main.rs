//! WebSocket cục bộ cho chế độ Taylor APO; chỉ đọc/ghi shared mapping, không đụng audio callback.
#[cfg(windows)]
mod win {
use serde_json::{json, Value};
use std::{ffi::c_void, io::{ErrorKind, Write}, mem::size_of, net::{TcpListener, TcpStream}, ptr, sync::atomic::{fence, AtomicU64, Ordering}, thread, time::{Duration, Instant}};
use tnd_dsp_core::{EngineProfile, SharedBlock, TndParams, TndTelemetry};
use tungstenite::{accept, Error as WsError, Message, WebSocket};
use uuid::Uuid;

type Handle = *mut c_void;
const FILE_MAP_ALL_ACCESS: u32 = 0x000F001F;
const PAGE_READWRITE: u32 = 0x04;
const SDDL_REVISION_1: u32 = 1;

#[repr(C)]
struct SecurityAttributes { length: u32, descriptor: *mut c_void, inherit: i32 }

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileMappingW(file: Handle, attributes: *mut SecurityAttributes, protect: u32, high: u32, low: u32, name: *const u16) -> Handle;
    fn MapViewOfFile(mapping: Handle, access: u32, high: u32, low: u32, bytes: usize) -> *mut c_void;
    fn UnmapViewOfFile(view: *const c_void) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
}
#[link(name = "advapi32")]
unsafe extern "system" { fn ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl: *const u16, revision: u32, descriptor: *mut *mut c_void, size: *mut u32) -> i32; }
#[link(name = "kernel32")]
unsafe extern "system" { fn LocalFree(memory: Handle) -> Handle; }

struct Mapping { handle: Handle, view: *mut SharedBlock }
unsafe impl Send for Mapping {}
impl Mapping {
    fn create() -> Result<Self, String> {
        unsafe {
            // DACL: SYSTEM đầy đủ; Local Service, Administrators và Users chỉ đọc/ghi vùng map.
            let sddl: Vec<u16> = "D:(A;;GA;;;SY)(A;;GRGW;;;LS)(A;;GRGW;;;BA)(A;;GRGW;;;BU)\0".encode_utf16().collect();
            let mut descriptor = ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, ptr::null_mut()) == 0 {
                return Err("Không tạo được ACL cho shared memory.".into());
            }
            let mut attributes = SecurityAttributes { length: size_of::<SecurityAttributes>() as u32, descriptor, inherit: 0 };
            let name: Vec<u16> = "Local\\TaylorNDAudio-APO-v1\0".encode_utf16().collect();
            let handle = CreateFileMappingW((-1isize) as Handle, &mut attributes, PAGE_READWRITE, 0, size_of::<SharedBlock>() as u32, name.as_ptr());
            LocalFree(descriptor);
            if handle.is_null() { return Err("Không tạo được shared memory cho Taylor APO.".into()); }
            let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, size_of::<SharedBlock>()) as *mut SharedBlock;
            if view.is_null() { CloseHandle(handle); return Err("Không ánh xạ được shared memory.".into()); }
            if (*view).magic != 0x544E4441 || (*view).version != 1 {
                ptr::write_bytes(view as *mut u8, 0, size_of::<SharedBlock>());
                (*view).profile = TndParams::default();
                (*view).magic = 0x544E4441;
                (*view).version = 1;
                fence(Ordering::SeqCst);
            }
            Ok(Self { handle, view })
        }
    }
    fn block(&self) -> &SharedBlock { unsafe { &*self.view } }
    fn write_profile(&mut self, value: TndParams) {
        unsafe {
            let sequence = &*(&mut (*self.view).profile_sequence as *mut u64 as *mut AtomicU64);
            sequence.fetch_add(1, Ordering::AcqRel); // số lẻ báo bridge đang cập nhật
            ptr::copy_nonoverlapping(&value, &mut (*self.view).profile, 1);
            fence(Ordering::Release);
            sequence.fetch_add(1, Ordering::Release);
        }
    }
    fn set_bypass(&mut self, bypass: bool) {
        let mut params = self.read_profile().unwrap_or_default();
        params.bypass = u32::from(bypass);
        self.write_profile(params);
    }
    fn read_profile(&self) -> Option<TndParams> {
        unsafe {
            let sequence = &*(&(*self.view).profile_sequence as *const u64 as *const AtomicU64);
            for _ in 0..4 {
                let first = sequence.load(Ordering::Acquire);
                if first & 1 != 0 { continue; }
                let copy = ptr::read_volatile(&(*self.view).profile);
                fence(Ordering::Acquire);
                if first == sequence.load(Ordering::Acquire) { return Some(copy); }
            }
        }
        None
    }
    fn read_telemetry(&self) -> Option<TndTelemetry> {
        unsafe {
            let block = &*self.view;
            let mut best = None;
            for index in 0..8 {
                let sequence = &*(&block.telemetry_sequence[index] as *const u64 as *const AtomicU64);
                for _ in 0..2 {
                    let first = sequence.load(Ordering::Acquire);
                    if first == 0 || first & 1 != 0 { continue; }
                    let copy = ptr::read_volatile(&block.telemetry[index]);
                    fence(Ordering::Acquire);
                    if first == sequence.load(Ordering::Acquire) && copy.heartbeat != 0 {
                        if best.map(|value: TndTelemetry| copy.heartbeat > value.heartbeat).unwrap_or(true) { best = Some(copy); }
                    }
                    break;
                }
            }
            best
        }
    }
}
impl Drop for Mapping {
    fn drop(&mut self) { unsafe { UnmapViewOfFile(self.view as *const c_void); CloseHandle(self.handle); } }
}

fn to_params(profile: EngineProfile) -> TndParams {
    TndParams { eq: profile.eq, bass: profile.effects.bass, treble: profile.effects.treble,
        dialogue: profile.effects.dialogue, width: profile.effects.width, balance: profile.effects.balance,
        crossfeed: profile.effects.crossfeed, master_db: profile.master_db,
        compressor_threshold: profile.effects.compressor_threshold, compressor_ratio: profile.effects.compressor_ratio,
        reverb_enabled: if profile.effects.reverb_enabled { 1 } else { 0 },
        compressor_enabled: if profile.effects.compressor_enabled { 1 } else { 0 },
        bypass: u32::from(profile.bypass) }
}

fn send_json(socket: &mut WebSocket<TcpStream>, value: Value) -> Result<(), WsError> {
    socket.send(Message::Text(value.to_string()))
}

fn telemetry_message(value: TndTelemetry) -> Value {
    json!({ "type":"telemetry", "peakL":value.peak_l, "peakR":value.peak_r, "rmsL":value.rms_l, "rmsR":value.rms_r,
        "spectrum":&value.spectrum[..], "waveform":&value.waveform[..], "sampleRate":value.sample_rate })
}

fn serve_client(stream: TcpStream, token: &str, mapping: &mut Mapping) -> Result<(), String> {
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    let mut socket = accept(stream).map_err(|e| e.to_string())?;
    let _ = socket.get_mut().set_nonblocking(true);
    let mut authenticated = false;
    let mut last_telemetry = Instant::now();
    let mut last_state = Instant::now();
    let mut last_heartbeat = 0;
    let mut last_heartbeat_at = Instant::now();
    loop {
        match socket.read() {
            Ok(message) if message.is_text() => {
                let parsed: Value = serde_json::from_str(message.to_text().unwrap_or_default()).unwrap_or(Value::Null);
                let kind = parsed.get("type").and_then(Value::as_str).unwrap_or("");
                if kind == "auth" {
                    authenticated = parsed.get("token").and_then(Value::as_str) == Some(token);
                    if !authenticated { return Err("Bridge từ chối token xác thực.".into()); }
                    let _ = send_json(&mut socket, json!({"type":"ack","request":"auth","ok":true,"message":"Đã xác thực Taylor APO bridge."}));
                    continue;
                }
                if !authenticated { return Err("Client chưa xác thực.".into()); }
                match kind {
                    "listDevices" => { let _ = send_json(&mut socket, json!({"type":"devices","devices":[],"cableDetected":false})); }
                    "setProfile" => {
                        let profile_value = parsed.get("profile").cloned().unwrap_or(Value::Null);
                        match serde_json::from_value::<EngineProfile>(profile_value) {
                            Ok(mut profile) => {
                                let ir_requested = profile.effects.reverb_enabled || !profile.effects.impulse_path.is_empty();
                                // Giữ EQ/bypass hoạt động, nhưng tắt IR để không báo áp dụng giả convolution.
                                profile.effects.reverb_enabled = false;
                                profile.effects.impulse_path.clear();
                                mapping.write_profile(to_params(profile));
                                let message = if ir_requested {
                                    "Đã áp dụng EQ và các hiệu ứng khác; convolution/IR chưa được hỗ trợ trong APO prototype."
                                } else {
                                    "Đã cập nhật hồ sơ; APO sẽ nhận ở lượt xử lý kế tiếp."
                                };
                                let _ = send_json(&mut socket, json!({"type":"ack","request":"setProfile","ok":!ir_requested,"message":message}));
                            }
                            Err(error) => { let _ = send_json(&mut socket, json!({"type":"ack","request":"setProfile","ok":false,"message":format!("Hồ sơ không hợp lệ: {error}")})); }
                        }
                    }
                    "setBypass" => {
                        mapping.set_bypass(parsed.get("bypass").and_then(Value::as_bool).unwrap_or(true));
                        let _ = send_json(&mut socket, json!({"type":"ack","request":"setBypass","ok":true,"message":"Đã cập nhật bypass."}));
                    }
                    "start" => { let _ = send_json(&mut socket, json!({"type":"ack","request":"start","ok":false,"message":"Taylor APO được gắn vào endpoint qua gói driver; không có lệnh Start thiết bị."})); }
                    "stop" => { mapping.set_bypass(true); let _ = send_json(&mut socket, json!({"type":"ack","request":"stop","ok":true,"message":"Đã bật bypass. APO vẫn nằm trong audio graph."})); }
                    "loadImpulse" => { let _ = send_json(&mut socket, json!({"type":"ack","request":"loadImpulse","ok":false,"message":"Nạp IR qua APO chưa được triển khai."})); }
                    _ => { let _ = send_json(&mut socket, json!({"type":"error","code":"unknown-command","message":"Lệnh không được hỗ trợ."})); }
                }
            }
            Ok(message) if message.is_close() => return Ok(()),
            Ok(_) => {}
            Err(WsError::Io(error)) if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut => {}
            Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => return Ok(()),
            Err(error) => return Err(format!("WebSocket lỗi: {error}")),
        }

        if authenticated && last_telemetry.elapsed() >= Duration::from_millis(33) {
            if let Some(snapshot) = mapping.read_telemetry() {
                if snapshot.heartbeat != last_heartbeat { last_heartbeat = snapshot.heartbeat; last_heartbeat_at = Instant::now(); }
                let _ = send_json(&mut socket, telemetry_message(snapshot));
            }
            last_telemetry = Instant::now();
        }
        if authenticated && last_state.elapsed() >= Duration::from_secs(1) {
            let snapshot = mapping.read_telemetry();
            let fresh = snapshot.map(|s| s.heartbeat != 0 && last_heartbeat_at.elapsed() < Duration::from_secs(2)).unwrap_or(false);
            let sample_rate = snapshot.map(|s| s.sample_rate).unwrap_or(0);
            let message = if fresh { "Taylor APO đang gửi heartbeat." } else { "Chưa thấy APO xử lý audio. Cần cài APO bằng gói INF và phát âm thanh để xác minh." };
            let _ = send_json(&mut socket, json!({"type":"state","running":fresh,"sampleRate":sample_rate,"latencyMs":1.5,"xruns":0,"message":message}));
            last_state = Instant::now();
        }
        thread::sleep(Duration::from_millis(2));
    }
}

pub fn run() {
    let mut mapping = match Mapping::create() { Ok(value) => value, Err(error) => { eprintln!("{error}"); std::process::exit(2); } };
    let listener = match TcpListener::bind("127.0.0.1:0") { Ok(value) => value, Err(error) => { eprintln!("Không mở được cổng IPC: {error}"); std::process::exit(3); } };
    let port = listener.local_addr().map(|address| address.port()).unwrap_or(0);
    let token = Uuid::new_v4().to_string();
    println!("{}", json!({"ready":true,"port":port,"token":token,"protocol":1}));
    let _ = std::io::stdout().flush();
    loop {
        match listener.accept() {
            Ok((stream, _)) => { if let Err(error) = serve_client(stream, &token, &mut mapping) { eprintln!("Bridge client kết thúc: {error}"); } }
            Err(error) if error.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(20)),
            Err(error) => { eprintln!("Lỗi accept WebSocket: {error}"); thread::sleep(Duration::from_millis(100)); }
        }
    }
}
}

#[cfg(windows)]
fn main() { win::run(); }

#[cfg(not(windows))]
fn main() { eprintln!("tnd-bridge chỉ hỗ trợ Windows."); std::process::exit(1); }
