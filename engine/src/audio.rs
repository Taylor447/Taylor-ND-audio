//! Backend CPAL/WASAPI cho MVP. Giao diện trait cho phép thay bằng backend IAudioClient3 sau.

use std::{sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc}, thread, time::{Duration, Instant}};

use cpal::{traits::{DeviceTrait, HostTrait, StreamTrait}, BufferSize, Device, Sample, SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use crossbeam_channel::{bounded, unbounded, Receiver, Sender, TryRecvError};
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use rtrb::{Consumer, Producer, RingBuffer};
use serde::Serialize;

use crate::dsp::{drift::DriftController, Dsp, EngineProfile, Telemetry, DSP_BLOCK_FRAMES};

const RING_FRAMES: usize = 65_536;
const RESAMPLE_ADJUSTMENT: f64 = 1.002;

/// Một phần tử ring là cả frame stereo, tránh lệch kênh khi ring gần đầy.
#[derive(Clone, Copy)]
struct StereoFrame { left: f32, right: f32 }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub direction: String,
    pub virtual_cable: bool,
    pub channels: u16,
    pub sample_rate: u32,
}

pub trait AudioBackend {
    type Session: AudioSessionControl;
    fn enumerate(&self) -> Result<Vec<DeviceInfo>, String>;
    fn start(&self, options: StartOptions) -> Result<Self::Session, String>;
}

/// Hợp đồng phiên audio độc lập backend để sau này thay CPAL bằng IAudioClient3.
pub trait AudioSessionControl {
    fn set_profile(&self, profile: EngineProfile) -> Result<(), String>;
    fn set_bypass(&self, bypass: bool) -> Result<(), String>;
    fn set_impulse(&self, convolver: crate::dsp::convolution::PartitionedConvolver) -> Result<(), String>;
    fn next_telemetry(&self) -> Option<Telemetry>;
    fn collect_retired(&self);
    fn xruns(&self) -> u64;
    fn device_lost(&self) -> bool;
    fn sample_rate(&self) -> u32;
    fn latency_ms(&self) -> f32;
    fn stop(&mut self);
}

/// COM watcher của Core Audio; callback chỉ đặt cờ nguyên tử và không chờ khóa nào.
pub struct HotplugWatcher {
    pub dirty: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl HotplugWatcher {
    pub fn start() -> Self {
        let dirty = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        #[cfg(windows)]
        let worker = {
            let callback_dirty = dirty.clone();
            let worker_stop = stop.clone();
            thread::Builder::new().name("Taylor Core Audio notifications".into()).spawn(move || {
                use windows::{
                    Win32::{
                        Media::Audio::{IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator},
                        System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED},
                        UI::Shell::PropertiesSystem::PROPERTYKEY,
                    },
                };
                let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };
                if !initialized { return; }
                let enumerator: windows::core::Result<IMMDeviceEnumerator> = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) };
                if let Ok(enumerator) = enumerator {
                    let callback: IMMNotificationClient = EndpointNotification { dirty: callback_dirty }.into();
                    let registered = unsafe { enumerator.RegisterEndpointNotificationCallback(&callback) }.is_ok();
                    while !worker_stop.load(Ordering::Relaxed) { thread::sleep(Duration::from_millis(100)); }
                    if registered { unsafe { let _ = enumerator.UnregisterEndpointNotificationCallback(&callback); } }
                }
                unsafe { CoUninitialize(); }
            }).ok()
        };
        #[cfg(not(windows))]
        let worker = None;
        Self { dirty, stop, worker }
    }
}

impl Drop for HotplugWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

#[cfg(windows)]
#[windows::core::implement(windows::Win32::Media::Audio::IMMNotificationClient)]
struct EndpointNotification { dirty: Arc<AtomicBool> }

#[cfg(windows)]
impl windows::Win32::Media::Audio::IMMNotificationClient_Impl for EndpointNotification_Impl {
    fn OnDeviceStateChanged(&self, _device_id: &windows::core::PCWSTR, _new_state: windows::Win32::Media::Audio::DEVICE_STATE) -> windows::core::Result<()> {
        self.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn OnDeviceAdded(&self, _device_id: &windows::core::PCWSTR) -> windows::core::Result<()> {
        self.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn OnDeviceRemoved(&self, _device_id: &windows::core::PCWSTR) -> windows::core::Result<()> {
        self.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn OnDefaultDeviceChanged(&self, _flow: windows::Win32::Media::Audio::EDataFlow, _role: windows::Win32::Media::Audio::ERole, _device_id: &windows::core::PCWSTR) -> windows::core::Result<()> {
        self.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn OnPropertyValueChanged(&self, _device_id: &windows::core::PCWSTR, _key: &windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY) -> windows::core::Result<()> {
        self.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }
}

pub struct WasapiCpalBackend;

impl AudioBackend for WasapiCpalBackend {
    type Session = AudioSession;
    fn enumerate(&self) -> Result<Vec<DeviceInfo>, String> { list_devices() }
    fn start(&self, options: StartOptions) -> Result<AudioSession, String> { AudioSession::start(options) }
}

#[derive(Clone, Debug)]
pub struct StartOptions {
    pub input_id: String,
    pub output_id: String,
    pub buffer_ms: u32,
}

pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    let host = cpal::default_host();
    let mut devices = Vec::new();
    for (direction, collection) in [("input", host.input_devices()), ("output", host.output_devices())] {
        let collection = collection.map_err(|error| format!("Không liệt kê được thiết bị {direction}: {error}"))?;
        for device in collection {
            let name = device.to_string();
            let config = if direction == "input" { device.default_input_config() } else { device.default_output_config() };
            let (channels, sample_rate) = config.map(|value| (value.channels(), value.sample_rate().0)).unwrap_or((2, 48_000));
            // CPAL 0.18 trả ID ổn định; giữ tên làm phương án dự phòng cho driver cũ.
            let id = device.id().map(|value| value.to_string()).unwrap_or_else(|_| name.clone());
            devices.push(DeviceInfo {
                id, virtual_cable: name.to_ascii_lowercase().contains("cable"),
                name, direction: direction.to_owned(), channels, sample_rate,
            });
        }
    }
    Ok(devices)
}

pub struct AudioSession {
    _input_stream: Stream,
    _output_stream: Stream,
    commands: Sender<WorkerCommand>,
    telemetry: Receiver<Telemetry>,
    retired_impulses: Receiver<crate::dsp::convolution::PartitionedConvolver>,
    xruns: Arc<AtomicU64>,
    device_lost: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
    pub sample_rate: u32,
    pub input_rate: u32,
    pub latency_ms: f32,
    pub input_id: String,
    pub output_id: String,
}

enum WorkerCommand { SetProfile(EngineProfile), SetImpulse(crate::dsp::convolution::PartitionedConvolver), ClearImpulse, Bypass(bool), Stop }

impl AudioSession {
    pub fn start(options: StartOptions) -> Result<Self, String> {
        if !matches!(options.buffer_ms, 5 | 10 | 20) { return Err("Buffer phải là 5, 10 hoặc 20 ms.".into()); }
        let input_name = options.input_id.trim();
        let output_name = options.output_id.trim();
        if input_name.is_empty() || output_name.is_empty() { return Err("Hãy chọn cả thiết bị đầu vào và đầu ra.".into()); }
        if output_name.to_ascii_lowercase().contains("cable input") || output_name.to_ascii_lowercase().contains("vb-audio cable") {
            return Err("Đầu ra không thể là CABLE Input/cáp ảo vì sẽ tạo vòng lặp âm thanh. Hãy chọn loa hoặc tai nghe thật.".into());
        }
        if input_name.eq_ignore_ascii_case(output_name) { return Err("Không thể dùng cùng một thiết bị làm đầu vào và đầu ra.".into()); }

        let host = cpal::default_host();
        let input_device = find_device(host.input_devices().map_err(|e| e.to_string())?, input_name)?;
        let output_device = find_device(host.output_devices().map_err(|e| e.to_string())?, output_name)?;
        let input_supported = input_device.default_input_config().map_err(|e| format!("Không mở được cấu hình đầu vào: {e}"))?;
        let output_supported = output_device.default_output_config().map_err(|e| format!("Không mở được cấu hình đầu ra: {e}"))?;
        let input_rate = input_supported.sample_rate().0;
        let output_rate = output_supported.sample_rate().0;
        let input_channels = input_supported.channels() as usize;
        let output_channels = output_supported.channels() as usize;
        if input_rate < 44_100 || output_rate < 44_100 { return Err("Thiết bị cần hỗ trợ ít nhất 44,1 kHz.".into()); }
        if input_rate > 192_000 || output_rate > 192_000 { return Err("Thiết bị vượt giới hạn hiện tại 192 kHz. Hãy chọn cấu hình 44,1/48/96 kHz trong Windows.".into()); }
        let input_config = preferred_config(&input_supported, options.buffer_ms);
        let output_config = preferred_config(&output_supported, options.buffer_ms);

        let (input_producer, input_consumer) = RingBuffer::<StereoFrame>::new(RING_FRAMES);
        let (mut output_producer, output_consumer) = RingBuffer::<StereoFrame>::new(RING_FRAMES);
        // Lót vài mili giây im lặng để stream đầu ra không bị tính xrun khi vừa mở.
        let startup_silence = (output_rate as usize * options.buffer_ms as usize / 1000).min(RING_FRAMES / 4);
        for _ in 0..startup_silence {
            let _ = output_producer.push(StereoFrame { left: 0.0, right: 0.0 });
        }
        let xruns = Arc::new(AtomicU64::new(0));
        let device_lost = Arc::new(AtomicBool::new(false));
        let input_stream = build_input_stream(&input_device, input_config, input_supported.sample_format(), input_channels,
            input_producer, xruns.clone(), device_lost.clone())?;
        let output_stream = build_output_stream(&output_device, output_config, output_supported.sample_format(), output_channels,
            output_consumer, xruns.clone(), device_lost.clone())?;

        let (commands, command_rx) = bounded::<WorkerCommand>(32);
        let (telemetry_tx, telemetry) = bounded::<Telemetry>(1);
        let (retired_tx, retired_impulses) = unbounded::<crate::dsp::convolution::PartitionedConvolver>();
        let (ready_tx, ready_rx) = bounded::<Result<(), String>>(1);
        let worker_xruns = xruns.clone();
        let output_capacity = RING_FRAMES;
        let worker = thread::Builder::new().name("Taylor DSP worker".into()).spawn(move || {
            run_audio_worker(input_consumer, output_producer, command_rx, telemetry_tx, worker_xruns,
                input_rate, output_rate, output_capacity, ready_tx, retired_tx);
        }).map_err(|error| format!("Không tạo được luồng DSP: {error}"))?;
        ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "DSP worker không khởi tạo kịp trong 5 giây.".to_owned())??;
        input_stream.play().map_err(|e| format!("Không khởi chạy được đầu vào: {e}"))?;
        output_stream.play().map_err(|e| format!("Không khởi chạy được đầu ra: {e}"))?;
        // Đây là ước tính bảo thủ từ hai buffer WASAPI, FIFO mục tiêu và khối DSP/resampler.
        let latency_ms = options.buffer_ms as f32 * 2.0 + 10.0
            + DSP_BLOCK_FRAMES as f32 * 1000.0 / output_rate as f32
            + 128.0 * 1000.0 / input_rate as f32;
        Ok(Self { _input_stream: input_stream, _output_stream: output_stream, commands, telemetry, retired_impulses, xruns, device_lost,
            worker: Some(worker), sample_rate: output_rate, input_rate, latency_ms,
            input_id: input_name.to_owned(), output_id: output_name.to_owned() })
    }

    pub fn set_profile(&self, profile: EngineProfile) -> Result<(), String> { self.commands.try_send(WorkerCommand::SetProfile(profile)).map_err(|_| "Hàng đợi cập nhật DSP đang đầy.".into()) }
    pub fn set_bypass(&self, bypass: bool) -> Result<(), String> { self.commands.try_send(WorkerCommand::Bypass(bypass)).map_err(|_| "Hàng đợi cập nhật DSP đang đầy.".into()) }
    pub fn set_impulse(&self, convolver: crate::dsp::convolution::PartitionedConvolver) -> Result<(), String> { self.commands.try_send(WorkerCommand::SetImpulse(convolver)).map_err(|_| "Hàng đợi cập nhật DSP đang đầy.".into()) }
    pub fn clear_impulse(&self) -> Result<(), String> { self.commands.try_send(WorkerCommand::ClearImpulse).map_err(|_| "Hàng đợi cập nhật DSP đang đầy.".into()) }
    pub fn next_telemetry(&self) -> Option<Telemetry> { self.telemetry.try_recv().ok() }
    /// Thu hồi IR cũ trên luồng điều khiển để worker không phải giải phóng bộ nhớ lớn.
    pub fn collect_retired(&self) { while let Ok(previous) = self.retired_impulses.try_recv() { drop(previous); } }
    pub fn xruns(&self) -> u64 { self.xruns.load(Ordering::Relaxed) }
    pub fn device_lost(&self) -> bool { self.device_lost.load(Ordering::Relaxed) }

    pub fn stop(&mut self) {
        // Dừng callback trước, rồi yêu cầu worker kết thúc và chờ giải phóng DSP.
        let _ = self._input_stream.pause();
        let _ = self._output_stream.pause();
        let _ = self.commands.send(WorkerCommand::Stop);
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

impl Drop for AudioSession { fn drop(&mut self) { self.stop(); } }

impl AudioSessionControl for AudioSession {
    fn set_profile(&self, profile: EngineProfile) -> Result<(), String> { AudioSession::set_profile(self, profile) }
    fn set_bypass(&self, bypass: bool) -> Result<(), String> { AudioSession::set_bypass(self, bypass) }
    fn set_impulse(&self, convolver: crate::dsp::convolution::PartitionedConvolver) -> Result<(), String> { AudioSession::set_impulse(self, convolver) }
    fn next_telemetry(&self) -> Option<Telemetry> { AudioSession::next_telemetry(self) }
    fn collect_retired(&self) { AudioSession::collect_retired(self); }
    fn xruns(&self) -> u64 { AudioSession::xruns(self) }
    fn device_lost(&self) -> bool { AudioSession::device_lost(self) }
    fn sample_rate(&self) -> u32 { self.sample_rate }
    fn latency_ms(&self) -> f32 { self.latency_ms }
    fn stop(&mut self) { AudioSession::stop(self); }
}

fn find_device(devices: impl Iterator<Item = Device>, name: &str) -> Result<Device, String> {
    devices.into_iter().find(|device| {
        device.id().is_ok_and(|candidate| candidate.to_string() == name)
            || device.to_string().eq_ignore_ascii_case(name)
    })
        .ok_or_else(|| format!("Không tìm thấy thiết bị “{name}”. Hãy liệt kê lại hoặc cắm thiết bị vào rồi thử lại.".into())
}

fn preferred_config(source: &SupportedStreamConfig, buffer_ms: u32) -> StreamConfig {
    let mut config: StreamConfig = source.clone().into();
    config.buffer_size = BufferSize::Fixed(((source.sample_rate().0 as u64 * buffer_ms as u64) / 1000).max(128) as u32);
    config
}

fn sample_to_f32<T: Sample>(sample: T) -> f32 where f32: cpal::FromSample<T> { sample.to_sample::<f32>() }
fn f32_to_sample<T: Sample>(sample: f32) -> T where T: cpal::FromSample<f32> { sample.to_sample::<T>() }

fn build_input_stream(device: &Device, config: StreamConfig, format: SampleFormat, channels: usize,
    producer: Producer<StereoFrame>, xruns: Arc<AtomicU64>, device_lost: Arc<AtomicBool>) -> Result<Stream, String> {
    macro_rules! build { ($kind:ty) => {{
        let mut producer = producer;
        device.build_input_stream(config.clone(), move |data: &[$kind], _| {
            let channel_count = channels.max(1);
            let mut overrun = false;
            for frame in data.chunks_exact(channel_count) {
                let mut left = 0.0f32; let mut right = 0.0f32; let mut left_n = 0usize; let mut right_n = 0usize;
                if channel_count == 1 { left = sample_to_f32(frame[0]); right = left; left_n = 1; right_n = 1; }
                else {
                    for (index, sample) in frame.iter().enumerate() {
                        if index % 2 == 0 { left += sample_to_f32(*sample); left_n += 1; }
                        else { right += sample_to_f32(*sample); right_n += 1; }
                    }
                    left /= left_n.max(1) as f32; right /= right_n.max(1) as f32;
                }
                if producer.push(StereoFrame { left, right }).is_err() { overrun = true; }
            }
            if overrun { xruns.fetch_add(1, Ordering::Relaxed); }
        }, move |_| { device_lost.store(true, Ordering::Relaxed); }, None)
            .map_err(|error| format!("Không tạo được luồng đầu vào ({format}): {error}"))
    }}; }
    match format {
        SampleFormat::F32 => build!(f32), SampleFormat::F64 => build!(f64), SampleFormat::I16 => build!(i16),
        SampleFormat::I24 => build!(cpal::I24), SampleFormat::I32 => build!(i32), SampleFormat::I8 => build!(i8),
        SampleFormat::U8 => build!(u8), SampleFormat::U16 => build!(u16), SampleFormat::U24 => build!(cpal::U24),
        SampleFormat::U32 => build!(u32), SampleFormat::I64 => build!(i64), SampleFormat::U64 => build!(u64),
        _ => Err(format!("Định dạng đầu vào {format} chưa hỗ trợ.")),
    }
}

fn build_output_stream(device: &Device, config: StreamConfig, format: SampleFormat, channels: usize,
    consumer: Consumer<StereoFrame>, xruns: Arc<AtomicU64>, device_lost: Arc<AtomicBool>) -> Result<Stream, String> {
    macro_rules! build { ($kind:ty) => {{
        let mut consumer = consumer;
        device.build_output_stream(config.clone(), move |data: &mut [$kind], _| {
            let channel_count = channels.max(1);
            let mut underrun = false;
            for frame in data.chunks_exact_mut(channel_count) {
                let sample = consumer.pop().ok();
                if sample.is_none() { underrun = true; }
                let sample = sample.unwrap_or(StereoFrame { left: 0.0, right: 0.0 });
                if channel_count == 1 { frame[0] = f32_to_sample::<$kind>((sample.left + sample.right) * 0.5); }
                else {
                    frame[0] = f32_to_sample::<$kind>(sample.left);
                    frame[1] = f32_to_sample::<$kind>(sample.right);
                    for channel in frame.iter_mut().skip(2) { *channel = f32_to_sample::<$kind>(0.0); }
                }
            }
            if underrun { xruns.fetch_add(1, Ordering::Relaxed); }
        }, move |_| { device_lost.store(true, Ordering::Relaxed); }, None)
            .map_err(|error| format!("Không tạo được luồng đầu ra ({format}): {error}"))
    }}; }
    match format {
        SampleFormat::F32 => build!(f32), SampleFormat::F64 => build!(f64), SampleFormat::I16 => build!(i16),
        SampleFormat::I24 => build!(cpal::I24), SampleFormat::I32 => build!(i32), SampleFormat::I8 => build!(i8),
        SampleFormat::U8 => build!(u8), SampleFormat::U16 => build!(u16), SampleFormat::U24 => build!(cpal::U24),
        SampleFormat::U32 => build!(u32), SampleFormat::I64 => build!(i64), SampleFormat::U64 => build!(u64),
        _ => Err(format!("Định dạng đầu ra {format} chưa hỗ trợ.")),
    }
}

fn run_audio_worker(mut input: Consumer<StereoFrame>, mut output: Producer<StereoFrame>, commands: Receiver<WorkerCommand>,
    telemetry: Sender<Telemetry>, xruns: Arc<AtomicU64>, input_rate: u32, output_rate: u32,
    output_capacity: usize, ready: Sender<Result<(), String>>,
    retired_impulses: Sender<crate::dsp::convolution::PartitionedConvolver>) {
    let _mmcss = MmcssGuard::enter("Pro Audio");
    let params = SincInterpolationParameters { sinc_len: 128, f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear, oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2 };
    let base_ratio = output_rate as f64 / input_rate as f64;
    let mut resampler = match SincFixedIn::<f32>::new(base_ratio, RESAMPLE_ADJUSTMENT, params, DSP_BLOCK_FRAMES, 2) {
        Ok(resampler) => resampler,
        Err(error) => { let _ = ready.send(Err(format!("Không tạo được bộ resample: {error}"))); return; }
    };
    let mut input_buffer = resampler.input_buffer_allocate();
    let mut output_buffer = resampler.output_buffer_allocate();
    for channel in &mut input_buffer { channel.resize(resampler.input_frames_max(), 0.0); }
    for channel in &mut output_buffer { channel.resize(resampler.output_frames_max(), 0.0); }
    let mut in_left = vec![0.0f32; resampler.input_frames_max()];
    let mut in_right = vec![0.0f32; resampler.input_frames_max()];
    let mut output_accum = vec![0.0f32; DSP_BLOCK_FRAMES * 2];
    let mut output_accum_frames = 0usize;
    let mut dsp = Dsp::new(output_rate);
    let mut active_profile = EngineProfile::default();
    let mut drift = DriftController::new(output_rate, 10.0);
    let mut last_telemetry = Instant::now();
    let _ = ready.send(Ok(()));
    loop {
        match commands.try_recv() {
            Ok(WorkerCommand::Stop) => break,
            Ok(WorkerCommand::SetProfile(profile)) => { active_profile = profile.clone(); dsp.set_profile(profile); },
            Ok(WorkerCommand::Bypass(bypass)) => { active_profile.bypass = bypass; dsp.set_profile(active_profile.clone()); },
            Ok(WorkerCommand::SetImpulse(convolver)) => {
                if let Some(previous) = dsp.set_impulse(Some(convolver)) { let _ = retired_impulses.send(previous); }
            }
            Ok(WorkerCommand::ClearImpulse) => {
                if let Some(previous) = dsp.set_impulse(None) { let _ = retired_impulses.send(previous); }
            }
            Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => {}
        }

        let needed = resampler.input_frames_next();
        if input.slots() < needed { thread::sleep(Duration::from_millis(1)); continue; }
        for frame in 0..needed {
            let sample = input.pop().unwrap_or(StereoFrame { left: 0.0, right: 0.0 });
            in_left[frame] = sample.left;
            in_right[frame] = sample.right;
        }
        input_buffer[0][..needed].copy_from_slice(&in_left[..needed]);
        input_buffer[1][..needed].copy_from_slice(&in_right[..needed]);

        // PI giữ vòng đệm phát gần 10 ms để bù lệch hai đồng hồ thiết bị.
        let queued_frames = output_capacity.saturating_sub(output.slots());
        let correction = drift.correction(queued_frames);
        if resampler.set_resample_ratio(base_ratio * (1.0 + correction), true).is_err() { xruns.fetch_add(1, Ordering::Relaxed); }
        let output_frames = resampler.output_frames_next();
        if resampler.process_into_buffer(&input_buffer, &mut output_buffer, None).is_err() {
            xruns.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        for frame in 0..output_frames {
            output_accum[output_accum_frames * 2] = output_buffer[0][frame];
            output_accum[output_accum_frames * 2 + 1] = output_buffer[1][frame];
            output_accum_frames += 1;
            if output_accum_frames == DSP_BLOCK_FRAMES {
                dsp.process_block(&mut output_accum);
                let mut overrun = false;
                for frame in output_accum.chunks_exact(2) {
                    if output.push(StereoFrame { left: frame[0], right: frame[1] }).is_err() { overrun = true; }
                }
                if overrun { xruns.fetch_add(1, Ordering::Relaxed); }
                output_accum_frames = 0;
            }
        }
        if last_telemetry.elapsed() >= Duration::from_millis(33) {
            let report = dsp.telemetry();
            let _ = telemetry.try_send(report);
            last_telemetry = Instant::now();
        }
        if output.slots() < output_capacity / 8 { thread::yield_now(); }
    }
}

struct MmcssGuard(Option<windows::Win32::Foundation::HANDLE>);
impl MmcssGuard {
    fn enter(task: &str) -> Self {
        #[cfg(windows)] {
            use windows::{core::PCWSTR, Win32::System::Threading::AvSetMmThreadCharacteristicsW};
            let task_wide: Vec<u16> = task.encode_utf16().chain(std::iter::once(0)).collect();
            let mut index = 0u32;
            let handle = unsafe { AvSetMmThreadCharacteristicsW(PCWSTR(task_wide.as_ptr()), &mut index).ok() };
            return Self(handle);
        }
        #[cfg(not(windows))]
        { let _ = task; Self(None) }
    }
}
impl Drop for MmcssGuard {
    fn drop(&mut self) {
        #[cfg(windows)] if let Some(handle) = self.0 {
            use windows::Win32::System::Threading::AvRevertMmThreadCharacteristics;
            unsafe { let _ = AvRevertMmThreadCharacteristics(handle); }
        }
    }
}
