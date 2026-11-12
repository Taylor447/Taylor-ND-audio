//! Lõi DSP dùng chung, cung cấp ABI C cho APO và harness.

#[path = "../../engine/src/dsp/mod.rs"]
mod engine_dsp;

use std::panic::{catch_unwind, AssertUnwindSafe};
use engine_dsp::Dsp;
pub use engine_dsp::{Effects, EngineProfile};

pub const TND_OK: i32 = 0;
pub const TND_INVALID_ARGUMENT: i32 = -1;
pub const TND_PANIC: i32 = -2;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct TndParams {
    pub eq: [f32; 10],
    pub bass: f32,
    pub treble: f32,
    pub dialogue: f32,
    pub width: f32,
    pub balance: f32,
    pub crossfeed: f32,
    pub master_db: f32,
    pub compressor_threshold: f32,
    pub compressor_ratio: f32,
    pub reverb_enabled: u32,
    pub compressor_enabled: u32,
    pub bypass: u32,
}

impl Default for TndParams {
    fn default() -> Self {
        Self { eq: [0.0; 10], bass: 0.0, treble: 0.0, dialogue: 0.0, width: 0.0,
            balance: 0.0, crossfeed: 0.0, master_db: 0.0, compressor_threshold: -18.0,
            compressor_ratio: 3.0, reverb_enabled: 0, compressor_enabled: 0, bypass: 0 }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct TndTelemetry {
    pub peak_l: f32,
    pub peak_r: f32,
    pub rms_l: f32,
    pub rms_r: f32,
    pub spectrum: [f32; 64],
    pub waveform: [f32; 1024],
    pub sample_rate: u32,
    pub reserved: u32,
    pub heartbeat: u64,
}

impl Default for TndTelemetry {
    fn default() -> Self { Self { peak_l: 0.0, peak_r: 0.0, rms_l: 0.0, rms_r: 0.0,
        spectrum: [0.0; 64], waveform: [0.0; 1024], sample_rate: 0, reserved: 0, heartbeat: 0 } }
}

/// Bố cục cố định giữa bridge Rust và DLL C++; mọi sequence là 64-bit căn 8 byte.
#[repr(C, align(8))]
pub struct SharedBlock {
    pub magic: u32,
    pub version: u32,
    pub profile_sequence: u64,
    pub profile: TndParams,
    pub next_telemetry_slot: i32,
    pub reserved: u32,
    pub telemetry_sequence: [u64; 8],
    pub telemetry: [TndTelemetry; 8],
}

pub struct TndHandle { dsp: Dsp }

fn finite(value: f32, low: f32, high: f32, fallback: f32) -> f32 {
    if value.is_finite() { value.clamp(low, high) } else { fallback }
}

fn make_profile(value: &TndParams) -> EngineProfile {
    EngineProfile {
        eq: std::array::from_fn(|i| finite(value.eq[i], -12.0, 12.0, 0.0)),
        effects: Effects {
            bass: finite(value.bass, -12.0, 12.0, 0.0),
            treble: finite(value.treble, -12.0, 12.0, 0.0),
            dialogue: finite(value.dialogue, -12.0, 12.0, 0.0),
            width: finite(value.width, -35.0, 35.0, 0.0),
            balance: finite(value.balance, -100.0, 100.0, 0.0),
            crossfeed: finite(value.crossfeed, 0.0, 35.0, 0.0),
            reverb_enabled: false,
            impulse_path: String::new(),
            compressor_enabled: value.compressor_enabled != 0,
            compressor_threshold: finite(value.compressor_threshold, -36.0, -3.0, -18.0),
            compressor_ratio: finite(value.compressor_ratio, 1.0, 12.0, 3.0),
        },
        bypass: value.bypass != 0,
        master_db: finite(value.master_db, -60.0, 6.0, 0.0),
    }
}

/// Tạo DSP trên luồng cấu hình, tuyệt đối không gọi trong APOProcess.
#[no_mangle]
pub unsafe extern "C" fn tnd_create(sample_rate: u32, channels: u32) -> *mut TndHandle {
    // DSP hiện được xác minh ở 44,1–192 kHz; ngoài khoảng này APO để audio passthrough.
    if channels != 2 || !(44_100..=192_000).contains(&sample_rate) { return std::ptr::null_mut(); }
    catch_unwind(|| Box::into_raw(Box::new(TndHandle { dsp: Dsp::new(sample_rate) })))
        .unwrap_or(std::ptr::null_mut())
}

/// Cập nhật tham số đã kiểm tra; hàm không cấp phát sau lần khởi tạo đầu.
#[no_mangle]
pub unsafe extern "C" fn tnd_set_params(handle: *mut TndHandle, params: *const TndParams) -> i32 {
    if handle.is_null() || params.is_null() { return TND_INVALID_ARGUMENT; }
    catch_unwind(AssertUnwindSafe(|| (*handle).dsp.set_profile(make_profile(&*params))))
        .map(|_| TND_OK).unwrap_or(TND_PANIC)
}

/// Xử lý tối đa 512 frame; caller phải chuẩn bị vùng đệm và bản dự phòng trước.
#[no_mangle]
pub unsafe extern "C" fn tnd_process(handle: *mut TndHandle, interleaved_stereo: *mut f32, frames: u32) -> i32 {
    if handle.is_null() || interleaved_stereo.is_null() || frames == 0 || frames > 512 { return TND_INVALID_ARGUMENT; }
    catch_unwind(AssertUnwindSafe(|| {
        let samples = std::slice::from_raw_parts_mut(interleaved_stereo, frames as usize * 2);
        (*handle).dsp.process_block(samples);
    })).map(|_| TND_OK).unwrap_or(TND_PANIC)
}

/// Lấy đồng hồ đo vào struct đã cấp sẵn, không phát sinh cấp phát.
#[no_mangle]
pub unsafe extern "C" fn tnd_read_telemetry(handle: *const TndHandle, output: *mut TndTelemetry) -> i32 {
    if handle.is_null() || output.is_null() { return TND_INVALID_ARGUMENT; }
    catch_unwind(AssertUnwindSafe(|| {
        let snapshot = &mut *output;
        let (pl, pr, rl, rr, rate) = (*handle).dsp.copy_telemetry_into(&mut snapshot.spectrum, &mut snapshot.waveform);
        snapshot.peak_l = pl; snapshot.peak_r = pr; snapshot.rms_l = rl; snapshot.rms_r = rr;
        snapshot.sample_rate = rate;
    })).map(|_| TND_OK).unwrap_or(TND_PANIC)
}

/// Độ trễ tối đa hiện tại của lookahead limiter: 1,5 ms = 15.000 HNSTIME.
#[no_mangle]
pub extern "C" fn tnd_latency_100ns() -> i64 { 15_000 }

#[no_mangle]
pub unsafe extern "C" fn tnd_destroy(handle: *mut TndHandle) {
    if !handle.is_null() { let _ = catch_unwind(AssertUnwindSafe(|| drop(Box::from_raw(handle)))); }
}
