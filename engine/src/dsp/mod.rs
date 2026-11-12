//! Chuỗi DSP stereo chạy trên worker, tách khỏi callback thiết bị.

mod biquad;
pub mod convolution;
pub mod drift;
mod limiter;

use std::path::Path;

use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::{Deserialize, Serialize};

use self::{biquad::{Biquad, FilterKind}, convolution::{ImpulseKernel, PartitionedConvolver}, limiter::LookaheadLimiter};

pub const DSP_BLOCK_FRAMES: usize = 256;
const EQ_FREQUENCIES: [f64; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0];
const FFT_SIZE: usize = 2_048;
const SAFETY_CEILING: f32 = 0.891_250_9;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct EngineProfile {
    pub eq: [f32; 10],
    pub effects: Effects,
    pub bypass: bool,
    #[serde(rename = "masterDb")]
    pub master_db: f32,
}

impl Default for EngineProfile {
    fn default() -> Self { Self { eq: [0.0; 10], effects: Effects::default(), bypass: false, master_db: 0.0 } }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Effects {
    pub bass: f32,
    pub treble: f32,
    pub dialogue: f32,
    pub width: f32,
    pub balance: f32,
    pub crossfeed: f32,
    pub reverb_enabled: bool,
    pub impulse_path: String,
    pub compressor_enabled: bool,
    pub compressor_threshold: f32,
    pub compressor_ratio: f32,
}

impl Default for Effects {
    fn default() -> Self { Self { bass: 0.0, treble: 0.0, dialogue: 0.0, width: 0.0, balance: 0.0, crossfeed: 0.0, reverb_enabled: false, impulse_path: String::new(), compressor_enabled: false, compressor_threshold: -18.0, compressor_ratio: 3.0 } }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    pub peak_l: f32,
    pub peak_r: f32,
    pub rms_l: f32,
    pub rms_r: f32,
    pub spectrum: Vec<f32>,
    pub waveform: Vec<f32>,
    pub sample_rate: u32,
}

pub struct Dsp {
    sample_rate: f64,
    smoothing: f32,
    filters: Vec<Biquad>,
    profile: EngineProfile,
    preamp_current: f32,
    preamp_target: f32,
    width_current: f32,
    width_target: f32,
    convolution_mix: f32,
    convolution_target: f32,
    convolution_step: f32,
    balance_l_current: f32,
    balance_r_current: f32,
    balance_l_target: f32,
    balance_r_target: f32,
    master_current: f32,
    master_target: f32,
    crossfeed_current: f32,
    crossfeed_target: f32,
    bypass_mix: f32,
    bypass_target: f32,
    bypass_step: f32,
    compressor_envelope: f32,
    compressor_attack: f32,
    compressor_attack_target: f32,
    compressor_release: f32,
    compressor_release_target: f32,
    compressor_threshold: f32,
    compressor_threshold_target: f32,
    compressor_ratio: f32,
    compressor_ratio_target: f32,
    compressor_mix: f32,
    compressor_mix_target: f32,
    convolver: Option<PartitionedConvolver>,
    convolver_left: Vec<f32>,
    convolver_right: Vec<f32>,
    convolver_dry_left: Vec<f32>,
    convolver_dry_right: Vec<f32>,
    convolution_mix_buffer: Vec<f32>,
    bypass_left: Vec<f32>,
    bypass_right: Vec<f32>,
    bypass_mix_buffer: Vec<f32>,
    limiter: LookaheadLimiter,
    fade_remaining: usize,
    fade_total: usize,
    fft: std::sync::Arc<dyn Fft<f32>>,
    fft_scratch: Vec<Complex<f32>>,
    fft_ring: Vec<Complex<f32>>,
    fft_frame: Vec<Complex<f32>>,
    fft_write: usize,
    fft_samples_since_update: usize,
    waveform: Vec<f32>,
    waveform_write: usize,
    peak_l: f32,
    peak_r: f32,
    rms_sum_l: f64,
    rms_sum_r: f64,
    rms_count: usize,
    rms_l: f32,
    rms_r: f32,
    spectrum: Vec<f32>,
}

impl Dsp {
    pub fn new(sample_rate: u32) -> Self {
        let rate = sample_rate.clamp(44_100, 192_000) as f64;
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let mut engine = Self {
            sample_rate: rate,
            smoothing: (1.0 - (-1.0 / (rate * 0.020)).exp()) as f32,
            filters: Vec::with_capacity(13), profile: EngineProfile::default(),
            preamp_current: 1.0, preamp_target: 1.0, width_current: 0.0, width_target: 0.0,
            convolution_mix: 0.0, convolution_target: 0.0,
            convolution_step: (1.0 / (rate * 0.020).max(1.0)) as f32,
            balance_l_current: 1.0, balance_r_current: 1.0, balance_l_target: 1.0, balance_r_target: 1.0,
            master_current: 1.0, master_target: 1.0, crossfeed_current: 0.0, crossfeed_target: 0.0,
            bypass_mix: 0.0, bypass_target: 0.0,
            bypass_step: (1.0 / (rate * 0.010).max(1.0)) as f32,
            compressor_envelope: 0.0,
            compressor_attack: 1.0 - (-1.0_f32 / (rate as f32 * 0.010)).exp(),
            compressor_attack_target: 1.0 - (-1.0_f32 / (rate as f32 * 0.010)).exp(),
            compressor_release: 1.0 - (-1.0_f32 / (rate as f32 * 0.120)).exp(),
            compressor_release_target: 1.0 - (-1.0_f32 / (rate as f32 * 0.120)).exp(),
            compressor_threshold: 10f32.powf(-18.0 / 20.0), compressor_threshold_target: 10f32.powf(-18.0 / 20.0),
            compressor_ratio: 3.0, compressor_ratio_target: 3.0, compressor_mix: 0.0, compressor_mix_target: 0.0,
            convolver: None,
            convolver_left: vec![0.0; DSP_BLOCK_FRAMES * 2],
            convolver_right: vec![0.0; DSP_BLOCK_FRAMES * 2],
            convolver_dry_left: vec![0.0; DSP_BLOCK_FRAMES * 2],
            convolver_dry_right: vec![0.0; DSP_BLOCK_FRAMES * 2],
            convolution_mix_buffer: vec![0.0; DSP_BLOCK_FRAMES * 2],
            bypass_left: vec![0.0; DSP_BLOCK_FRAMES * 2], bypass_right: vec![0.0; DSP_BLOCK_FRAMES * 2],
            bypass_mix_buffer: vec![0.0; DSP_BLOCK_FRAMES * 2],
            limiter: LookaheadLimiter::new(rate as u32, 0.0015, 10f32.powf(-1.0 / 20.0)),
            fade_remaining: (rate * 0.200) as usize, fade_total: (rate * 0.200) as usize,
            fft_scratch: vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()],
            fft, fft_ring: vec![Complex::new(0.0, 0.0); FFT_SIZE], fft_frame: vec![Complex::new(0.0, 0.0); FFT_SIZE], fft_write: 0,
            fft_samples_since_update: 0, waveform: vec![0.0; 1024], waveform_write: 0,
            peak_l: 0.0, peak_r: 0.0, rms_sum_l: 0.0, rms_sum_r: 0.0, rms_count: 0,
            rms_l: 0.0, rms_r: 0.0, spectrum: vec![0.0; 64],
        };
        engine.set_profile(EngineProfile::default());
        engine
    }

    /// Cập nhật profile không tạo Vec tạm sau khởi tạo; việc tính hệ số vẫn theo luồng gọi.
    pub fn set_profile(&mut self, profile: EngineProfile) {
        if self.filters.is_empty() {
            // Dự phòng chỉ dùng lúc khởi tạo; capacity 13 đã được đặt trong new().
            for index in 0..10 {
                self.filters.push(Biquad::new(FilterKind::Peak, EQ_FREQUENCIES[index], profile.eq[index].clamp(-12.0, 12.0) as f64, 1.41, self.sample_rate));
            }
            self.filters.push(Biquad::new(FilterKind::LowShelf, 100.0, profile.effects.bass.clamp(-12.0, 12.0) as f64, std::f64::consts::FRAC_1_SQRT_2, self.sample_rate));
            self.filters.push(Biquad::new(FilterKind::HighShelf, 8_000.0, profile.effects.treble.clamp(-12.0, 12.0) as f64, std::f64::consts::FRAC_1_SQRT_2, self.sample_rate));
            self.filters.push(Biquad::new(FilterKind::Peak, 2_500.0, profile.effects.dialogue.clamp(-12.0, 12.0) as f64, 1.0, self.sample_rate));
        } else {
            for index in 0..10 {
                self.filters[index].set_target(FilterKind::Peak, EQ_FREQUENCIES[index], profile.eq[index].clamp(-12.0, 12.0) as f64, 1.41, self.sample_rate);
            }
            self.filters[10].set_target(FilterKind::LowShelf, 100.0, profile.effects.bass.clamp(-12.0, 12.0) as f64, std::f64::consts::FRAC_1_SQRT_2, self.sample_rate);
            self.filters[11].set_target(FilterKind::HighShelf, 8_000.0, profile.effects.treble.clamp(-12.0, 12.0) as f64, std::f64::consts::FRAC_1_SQRT_2, self.sample_rate);
            self.filters[12].set_target(FilterKind::Peak, 2_500.0, profile.effects.dialogue.clamp(-12.0, 12.0) as f64, 1.0, self.sample_rate);
        }
        // Dự trữ headroom theo tổng tăng dương bảo thủ; master gain luôn bị chặn ở +6 dB.
        let positive = profile.eq.iter().map(|g| g.max(0.0)).sum::<f32>()
            + profile.effects.bass.max(0.0) + profile.effects.treble.max(0.0) + profile.effects.dialogue.max(0.0);
        let width = profile.effects.width.clamp(-35.0, 35.0) / 100.0;
        let matrix_gain_db = if width < 0.0 { 20.0 * (1.0 - 2.0 * width).log10() } else { 0.0 };
        self.preamp_target = 10f32.powf(-(positive + matrix_gain_db).min(42.0) / 20.0);
        self.width_target = width;
        let balance = profile.effects.balance.clamp(-100.0, 100.0);
        self.balance_l_target = if balance > 0.0 { 10f32.powf(-balance / 20.0) } else { 1.0 };
        self.balance_r_target = if balance < 0.0 { 10f32.powf(balance / 20.0) } else { 1.0 };
        self.master_target = 10f32.powf(profile.master_db.clamp(-60.0, 6.0) / 20.0);
        self.crossfeed_target = (profile.effects.crossfeed.clamp(0.0, 35.0) / 100.0)
            .max(width.max(0.0) * 0.5).clamp(0.0, 0.35);
        self.compressor_attack_target = 1.0 - (-1.0_f32 / (self.sample_rate as f32 * 0.010)).exp();
        self.compressor_release_target = 1.0 - (-1.0_f32 / (self.sample_rate as f32 * 0.120)).exp();
        self.compressor_threshold_target = 10f32.powf(profile.effects.compressor_threshold.clamp(-36.0, -3.0) / 20.0);
        self.compressor_ratio_target = profile.effects.compressor_ratio.clamp(1.0, 12.0);
        self.compressor_mix_target = if profile.effects.compressor_enabled { 1.0 } else { 0.0 };
        self.bypass_target = if profile.bypass { 1.0 } else { 0.0 };
        self.convolution_target = if profile.effects.reverb_enabled && !profile.effects.impulse_path.is_empty() && self.convolver.is_some() { 1.0 } else { 0.0 };
        self.profile = profile;
    }

    /// Đọc, kiểm tra và phân vùng IR trên luồng điều khiển rồi mới gắn vào worker DSP.
    pub fn prepare_impulse(path: &Path, sample_rate: u32) -> Result<ImpulseKernel, String> {
        ImpulseKernel::from_wav(path, sample_rate)
    }

    pub fn set_impulse(&mut self, convolver: Option<PartitionedConvolver>) -> Option<PartitionedConvolver> {
        let previous = std::mem::replace(&mut self.convolver, convolver);
        // Khi thay IR, đưa tín hiệu về dry rồi fade lên convolution mới trong 20 ms.
        self.convolution_mix = 0.0;
        self.convolution_target = if self.profile.effects.reverb_enabled
            && !self.profile.effects.impulse_path.is_empty() && self.convolver.is_some() { 1.0 } else { 0.0 };
        previous
    }

    /// Xử lý tối đa 512 frame stereo; không cấp phát bộ nhớ trong hàm này.
    pub fn process_block(&mut self, samples: &mut [f32]) {
        if samples.len() % 2 != 0 || samples.is_empty() || samples.len() > DSP_BLOCK_FRAMES * 4
            || ((self.convolution_target > 0.0 || self.convolution_mix > 0.0)
                && samples.len() != DSP_BLOCK_FRAMES * 2) { return; }
        let frames = samples.len() / 2;
        for frame in 0..frames {
            let raw_l = samples[frame * 2];
            let raw_r = samples[frame * 2 + 1];
            self.bypass_left[frame] = raw_l;
            self.bypass_right[frame] = raw_r;
            self.preamp_current += (self.preamp_target - self.preamp_current) * self.smoothing;
            self.width_current += (self.width_target - self.width_current) * self.smoothing;
            self.balance_l_current += (self.balance_l_target - self.balance_l_current) * self.smoothing;
            self.balance_r_current += (self.balance_r_target - self.balance_r_current) * self.smoothing;
            self.master_current += (self.master_target - self.master_current) * self.smoothing;
            self.crossfeed_current += (self.crossfeed_target - self.crossfeed_current) * self.smoothing;
            self.compressor_attack += (self.compressor_attack_target - self.compressor_attack) * self.smoothing;
            self.compressor_release += (self.compressor_release_target - self.compressor_release) * self.smoothing;
            self.compressor_threshold += (self.compressor_threshold_target - self.compressor_threshold) * self.smoothing;
            self.compressor_ratio += (self.compressor_ratio_target - self.compressor_ratio) * self.smoothing;
            self.compressor_mix += (self.compressor_mix_target - self.compressor_mix) * self.smoothing;
            // Crossfade tuyến tính chạm đúng đích sau 10 ms để bypass thật sự bit-perfect.
            if self.bypass_mix < self.bypass_target {
                self.bypass_mix = (self.bypass_mix + self.bypass_step).min(self.bypass_target);
            } else if self.bypass_mix > self.bypass_target {
                self.bypass_mix = (self.bypass_mix - self.bypass_step).max(self.bypass_target);
            }
            self.bypass_mix_buffer[frame] = self.bypass_mix;
            if self.convolution_mix < self.convolution_target {
                self.convolution_mix = (self.convolution_mix + self.convolution_step).min(self.convolution_target);
            } else if self.convolution_mix > self.convolution_target {
                self.convolution_mix = (self.convolution_mix - self.convolution_step).max(self.convolution_target);
            }
            self.convolution_mix_buffer[frame] = self.convolution_mix;

            let mut left = raw_l * self.preamp_current;
            let mut right = raw_r * self.preamp_current;
            for filter in &mut self.filters {
                filter.advance();
                left = filter.process(0, left);
                right = filter.process(1, right);
            }

            // Ma trận mid/side: số âm mở rộng stereo, số dương thu hẹp âm trường.
            let mid = (left + right) * 0.5;
            let side = (left - right) * 0.5 * (1.0 - self.width_current * 2.0);
            left = (mid + side) * self.balance_l_current;
            right = (mid - side) * self.balance_r_current;
            let crossfeed = self.crossfeed_current;
            if crossfeed > 0.0 {
                let old_l = left;
                let old_r = right;
                left = old_l * (1.0 - crossfeed) + old_r * crossfeed;
                right = old_r * (1.0 - crossfeed) + old_l * crossfeed;
            }

            self.convolver_dry_left[frame] = left;
            self.convolver_dry_right[frame] = right;
            if self.convolver.is_some() && (self.convolution_mix > 0.0 || self.convolution_target > 0.0) {
                if let Some(convolver) = self.convolver.as_mut() {
                    self.convolver_left[frame] = left;
                    self.convolver_right[frame] = right;
                    if frame == DSP_BLOCK_FRAMES - 1 {
                        convolver.process_block(&mut self.convolver_left[..DSP_BLOCK_FRAMES], &mut self.convolver_right[..DSP_BLOCK_FRAMES]);
                    }
                }
            } else {
                self.convolver_left[frame] = left;
                self.convolver_right[frame] = right;
            }
        }

        for frame in 0..frames {
            let convolution_mix = self.convolution_mix_buffer[frame].clamp(0.0, 1.0);
            let mut left = self.convolver_left[frame] * convolution_mix
                + self.convolver_dry_left[frame] * (1.0 - convolution_mix);
            let mut right = self.convolver_right[frame] * convolution_mix
                + self.convolver_dry_right[frame] * (1.0 - convolution_mix);
            // Compressor đặt sau convolution theo đúng chuỗi tín hiệu của engine.
            let detector = left.abs().max(right.abs());
            let coefficient = if detector > self.compressor_envelope { self.compressor_attack } else { self.compressor_release };
            self.compressor_envelope += (detector - self.compressor_envelope) * coefficient;
            if self.compressor_mix > 0.000_01 && self.compressor_envelope > self.compressor_threshold {
                let compressed = self.compressor_threshold
                    * (self.compressor_envelope / self.compressor_threshold).powf(1.0 / self.compressor_ratio.max(1.0));
                let gain = compressed / self.compressor_envelope.max(1e-8);
                let wet_l = left * gain;
                let wet_r = right * gain;
                left += (wet_l - left) * self.compressor_mix;
                right += (wet_r - right) * self.compressor_mix;
            }

            // Limiter xử lý trước master; giảm trần nội bộ tương ứng với gain dương.
            self.limiter.set_ceiling(SAFETY_CEILING / self.master_current.max(1.0));
            let (limited_l, limited_r) = self.limiter.process(left, right);
            left = limited_l * self.master_current;
            right = limited_r * self.master_current;
            // Crossfade đặt sau đường wet để bypass bỏ qua EQ, IR, compressor và gain.
            // Mẫu thấp hơn trần -1 dBFS được giữ bit-perfect; trần bảo vệ vẫn có hiệu lực.
            let bypass = self.bypass_mix_buffer[frame].clamp(0.0, 1.0);
            let mut left = left * (1.0 - bypass) + self.bypass_left[frame] * bypass;
            let mut right = right * (1.0 - bypass) + self.bypass_right[frame] * bypass;
            if self.fade_remaining > 0 {
                let fade = 1.0 - self.fade_remaining as f32 / self.fade_total.max(1) as f32;
                left *= fade;
                right *= fade;
                self.fade_remaining -= 1;
            }
            samples[frame * 2] = left.clamp(-SAFETY_CEILING, SAFETY_CEILING);
            samples[frame * 2 + 1] = right.clamp(-SAFETY_CEILING, SAFETY_CEILING);
            self.update_meters(samples[frame * 2], samples[frame * 2 + 1]);
        }
    }

    fn update_meters(&mut self, left: f32, right: f32) {
        self.peak_l = self.peak_l.max(left.abs());
        self.peak_r = self.peak_r.max(right.abs());
        self.rms_sum_l += (left as f64) * (left as f64);
        self.rms_sum_r += (right as f64) * (right as f64);
        self.rms_count += 1;
        if self.rms_count >= (self.sample_rate as usize / 30).max(1) {
            self.rms_l = (self.rms_sum_l / self.rms_count as f64).sqrt() as f32;
            self.rms_r = (self.rms_sum_r / self.rms_count as f64).sqrt() as f32;
            self.rms_sum_l = 0.0;
            self.rms_sum_r = 0.0;
            self.rms_count = 0;
            self.peak_l *= 0.82;
            self.peak_r *= 0.82;
        }
        self.fft_ring[self.fft_write] = Complex::new((left + right) * 0.5, 0.0);
        self.fft_write = (self.fft_write + 1) % FFT_SIZE;
        self.fft_samples_since_update += 1;
        self.waveform[self.waveform_write] = (left + right) * 0.5;
        self.waveform_write = (self.waveform_write + 1) % self.waveform.len();
        if self.fft_samples_since_update >= self.sample_rate as usize / 30 {
            self.update_spectrum();
            self.fft_samples_since_update = 0;
        }
    }

    fn update_spectrum(&mut self) {
        // Đọc vòng lịch sử theo thứ tự thời gian và áp cửa sổ Hann trước FFT.
        for index in 0..FFT_SIZE {
            let sample = self.fft_ring[(self.fft_write + index) % FFT_SIZE].re;
            let hann = 0.5 - 0.5 * (std::f32::consts::TAU * index as f32 / (FFT_SIZE - 1) as f32).cos();
            self.fft_frame[index] = Complex::new(sample * hann, 0.0);
        }
        self.fft.process_with_scratch(&mut self.fft_frame, &mut self.fft_scratch);
        let bin_hz = self.sample_rate as f32 / FFT_SIZE as f32;
        for (index, level) in self.spectrum.iter_mut().enumerate() {
            let low = 20.0 * (20_000.0_f32 / 20.0).powf(index as f32 / 64.0);
            let high = 20.0 * (20_000.0_f32 / 20.0).powf((index + 1) as f32 / 64.0);
            let first = (low / bin_hz).floor().max(1.0) as usize;
            let last = ((high / bin_hz).ceil() as usize).max(first + 1).min(FFT_SIZE / 2);
            let mut peak = 0.0f32;
            for bin in first..last { peak = peak.max(self.fft_frame[bin].norm() / FFT_SIZE as f32); }
            *level = (20.0 * peak.max(1e-7).log10()).clamp(-90.0, 0.0);
        }
    }

    pub fn telemetry(&self) -> Telemetry {
        let mut waveform = Vec::with_capacity(self.waveform.len());
        waveform.extend_from_slice(&self.waveform[self.waveform_write..]);
        waveform.extend_from_slice(&self.waveform[..self.waveform_write]);
        Telemetry { peak_l: self.peak_l, peak_r: self.peak_r, rms_l: self.rms_l, rms_r: self.rms_r,
            spectrum: self.spectrum.clone(), waveform, sample_rate: self.sample_rate as u32 }
    }

    /// Sao chép telemetry vào vùng caller đã cấp sẵn; không tạo Vec mới.
    pub fn copy_telemetry_into(&self, spectrum: &mut [f32; 64], waveform: &mut [f32; 1024]) -> (f32, f32, f32, f32, u32) {
        spectrum.copy_from_slice(&self.spectrum);
        let split = self.waveform_write;
        let first = self.waveform.len() - split;
        waveform[..first].copy_from_slice(&self.waveform[split..]);
        waveform[first..].copy_from_slice(&self.waveform[..split]);
        (self.peak_l, self.peak_r, self.rms_l, self.rms_r, self.sample_rate as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(engine: &mut Dsp, source: f32) -> Vec<f32> {
        let mut block = vec![source; DSP_BLOCK_FRAMES * 2];
        engine.process_block(&mut block);
        block
    }

    #[test]
    fn preset_json_uses_current_renderer_shape() {
        let profile: EngineProfile = serde_json::from_str(r#"{"eq":[1,2,3,4,5,6,7,8,9,10],"effects":{"bass":2,"treble":1,"width":-8,"balance":0,"reverbEnabled":false,"impulsePath":"","compressorEnabled":false},"bypass":false}"#).unwrap();
        assert_eq!(profile.eq[9], 10.0);
        assert_eq!(profile.effects.width, -8.0);
    }

    #[test]
    fn steady_bypass_returns_non_clipped_input_samples_bit_for_bit() {
        let mut engine = Dsp::new(48_000);
        let mut profile = EngineProfile::default();
        profile.bypass = true;
        engine.set_profile(profile);
        for _ in 0..50 { let _ = run(&mut engine, 0.1234567); }
        let mut output = (0..DSP_BLOCK_FRAMES * 2).map(|index| (index as f32 * 0.017).sin() * 0.7).collect::<Vec<_>>();
        let expected = output.clone();
        engine.process_block(&mut output);
        assert!(output.iter().zip(expected).all(|(actual, original)| actual.to_bits() == original.to_bits()));
    }

    #[test]
    fn bypass_skips_loaded_convolution_path() {
        // IR rút gọn làm giảm âm lượng wet để kiểm tra bypass thật sự lấy mẫu dry.
        let path = std::env::temp_dir().join(format!("tnd-bypass-ir-{}.wav", std::process::id()));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        writer.write_sample(0.25f32).unwrap();
        writer.finalize().unwrap();

        let mut engine = Dsp::new(48_000);
        let mut profile = EngineProfile::default();
        profile.effects.reverb_enabled = true;
        engine.set_profile(profile.clone());
        let prepared = PartitionedConvolver::new(Dsp::prepare_impulse(&path, 48_000).unwrap());
        let _ = engine.set_impulse(Some(prepared));
        for _ in 0..45 { let _ = run(&mut engine, 0.1); }

        profile.bypass = true;
        engine.set_profile(profile);
        for _ in 0..12 { let _ = run(&mut engine, 0.1); }
        let mut output = (0..DSP_BLOCK_FRAMES * 2)
            .map(|index| (index as f32 * 0.013).sin() * 0.4)
            .collect::<Vec<_>>();
        let expected = output.clone();
        engine.process_block(&mut output);
        assert!(output.iter().zip(expected).all(|(actual, original)| actual.to_bits() == original.to_bits()));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn limiter_never_exceeds_minus_one_dbfs() {
        let mut engine = Dsp::new(48_000);
        for _ in 0..50 { let _ = run(&mut engine, 4.0); }
        let output = run(&mut engine, 4.0);
        assert!(output.iter().all(|sample| sample.abs() <= 10f32.powf(-1.0 / 20.0)));
    }

    #[test]
    fn limiter_keeps_safety_ceiling_with_maximum_master_gain() {
        let mut engine = Dsp::new(48_000);
        let mut profile = EngineProfile::default();
        profile.master_db = 6.0;
        engine.set_profile(profile);
        for _ in 0..50 { let _ = run(&mut engine, 4.0); }
        let output = run(&mut engine, 4.0);
        assert!(output.iter().all(|sample| sample.abs() <= 10f32.powf(-1.0 / 20.0)));
    }

    #[test]
    fn response_for_peak_filter_matches_requested_gain_at_center() {
        let filter = Biquad::new(FilterKind::Peak, 1_000.0, 6.0, 1.0, 48_000.0);
        let magnitude = filter.response_db(1_000.0, 48_000.0);
        assert!((magnitude - 6.0).abs() < 0.03);
    }

    #[test]
    fn automatic_preamp_reserves_headroom_for_widened_side_signal() {
        let mut engine = Dsp::new(48_000);
        let mut profile = EngineProfile::default();
        profile.effects.width = -35.0;
        engine.set_profile(profile);
        assert!(engine.preamp_target < 0.60);
        assert!(engine.preamp_target > 0.57);
    }

    #[test]
    fn crossfeed_and_compressor_enable_are_smoothed() {
        let mut engine = Dsp::new(48_000);
        let mut profile = EngineProfile::default();
        profile.effects.crossfeed = 30.0;
        profile.effects.compressor_enabled = true;
        engine.set_profile(profile);
        assert_eq!(engine.crossfeed_current, 0.0);
        assert_eq!(engine.compressor_mix, 0.0);
        let _ = run(&mut engine, 0.1);
        assert!(engine.crossfeed_current > 0.0 && engine.crossfeed_current < 0.3);
        assert!(engine.compressor_mix > 0.0 && engine.compressor_mix < 1.0);
    }

    #[test]
    fn unit_impulse_is_stable_and_step_response_is_finite() {
        let mut filter = Biquad::new(FilterKind::Peak, 500.0, 4.0, 1.41, 48_000.0);
        let mut impulse = Vec::new();
        for index in 0..2048 { impulse.push(filter.process(0, if index == 0 { 1.0 } else { 0.0 })); }
        assert!(impulse.iter().all(|value| value.is_finite()));
        let mut step = Biquad::new(FilterKind::LowShelf, 100.0, 6.0, std::f64::consts::FRAC_1_SQRT_2, 48_000.0);
        let mut last = 0.0;
        for _ in 0..10_000 { last = step.process(0, 1.0); }
        assert!(last.is_finite() && last > 1.7 && last < 2.1);
    }
}
