//! Convolution overlap-add theo các phân vùng 256 mẫu, FFT được chuẩn bị ngoài callback.

use std::{path::Path, sync::Arc};

use hound::{SampleFormat, WavReader};
use rustfft::{num_complex::Complex, Fft, FftPlanner};

use super::DSP_BLOCK_FRAMES;

const PARTITION: usize = DSP_BLOCK_FRAMES;
const FFT_SIZE: usize = PARTITION * 2;

#[derive(Clone)]
pub struct ImpulseKernel {
    pub sample_rate: u32,
    partitions: [Vec<Vec<Complex<f32>>>; 2],
}

impl ImpulseKernel {
    pub fn from_wav(path: &Path, sample_rate: u32) -> Result<Self, String> {
        let mut reader = WavReader::open(path).map_err(|error| format!("Không đọc được IR WAV: {error}"))?;
        let spec = reader.spec();
        if spec.sample_rate != sample_rate {
            return Err(format!("IR có tần số {} Hz nhưng engine đang chạy {} Hz. Hãy đổi mẫu WAV sang cùng tần số.", spec.sample_rate, sample_rate));
        }
        if spec.channels == 0 || spec.channels > 8 { return Err("IR WAV cần có từ 1 đến 8 kênh.".into()); }
        let samples: Vec<f32> = match spec.sample_format {
            SampleFormat::Float => reader.samples::<f32>().map(|s| s.map_err(|e| e.to_string())).collect::<Result<_, _>>()?,
            SampleFormat::Int => {
                let scale = (1u64 << (spec.bits_per_sample.saturating_sub(1).min(31))) as f32;
                reader.samples::<i32>().map(|s| s.map(|v| v as f32 / scale).map_err(|e| e.to_string())).collect::<Result<_, _>>()?
            }
        };
        let frames = samples.len() / spec.channels as usize;
        if frames == 0 { return Err("IR WAV không có mẫu âm thanh.".into()); }
        if frames > sample_rate as usize * 5 { return Err("IR dài quá 5 giây; hãy rút ngắn để giới hạn CPU và bộ nhớ.".into()); }
        let mut stereo = [Vec::with_capacity(frames), Vec::with_capacity(frames)];
        for frame in samples.chunks_exact(spec.channels as usize) {
            let left = frame.iter().step_by(2).copied().sum::<f32>() / ((spec.channels as usize + 1) / 2) as f32;
            let right = if spec.channels == 1 { left } else { frame.iter().skip(1).step_by(2).copied().sum::<f32>() / (spec.channels as usize / 2) as f32 };
            stereo[0].push(left.clamp(-4.0, 4.0));
            stereo[1].push(right.clamp(-4.0, 4.0));
        }
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let mut partitions: [Vec<Vec<Complex<f32>>>; 2] = [Vec::new(), Vec::new()];
        for channel in 0..2 {
            for slice in stereo[channel].chunks(PARTITION) {
                let mut frequency = vec![Complex::new(0.0, 0.0); FFT_SIZE];
                for (index, sample) in slice.iter().enumerate() { frequency[index].re = *sample; }
                fft.process(&mut frequency);
                partitions[channel].push(frequency);
            }
        }
        Ok(Self { sample_rate, partitions })
    }
}

pub struct PartitionedConvolver {
    kernel: Arc<ImpulseKernel>,
    fft: Arc<dyn Fft<f32>>,
    ifft: Arc<dyn Fft<f32>>,
    history: [Vec<Vec<Complex<f32>>>; 2],
    scratch: [Vec<Complex<f32>>; 2],
    fft_scratch: [Vec<Complex<f32>>; 2],
    ifft_scratch: [Vec<Complex<f32>>; 2],
    overlap: [Vec<f32>; 2],
    cursor: usize,
}

impl PartitionedConvolver {
    pub fn new(kernel: ImpulseKernel) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let ifft = planner.plan_fft_inverse(FFT_SIZE);
        let partitions = kernel.partitions[0].len();
        let fft_scratch_len = fft.get_inplace_scratch_len();
        let ifft_scratch_len = ifft.get_inplace_scratch_len();
        Self { kernel: Arc::new(kernel), fft, ifft,
            history: [vec![vec![Complex::new(0.0, 0.0); FFT_SIZE]; partitions], vec![vec![Complex::new(0.0, 0.0); FFT_SIZE]; partitions]],
            scratch: [vec![Complex::new(0.0, 0.0); FFT_SIZE], vec![Complex::new(0.0, 0.0); FFT_SIZE]],
            fft_scratch: [vec![Complex::new(0.0, 0.0); fft_scratch_len], vec![Complex::new(0.0, 0.0); fft_scratch_len]],
            ifft_scratch: [vec![Complex::new(0.0, 0.0); ifft_scratch_len], vec![Complex::new(0.0, 0.0); ifft_scratch_len]],
            overlap: [vec![0.0; PARTITION], vec![0.0; PARTITION]], cursor: 0 }
    }

    pub fn process_block(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (channel, block) in [left, right].into_iter().enumerate() {
            let scratch = &mut self.scratch[channel];
            scratch.fill(Complex::new(0.0, 0.0));
            for (index, sample) in block.iter().enumerate().take(PARTITION) { scratch[index].re = *sample; }
            self.fft.process_with_scratch(scratch, &mut self.fft_scratch[channel]);
            self.history[channel][self.cursor].copy_from_slice(scratch);
            scratch.fill(Complex::new(0.0, 0.0));
            for (partition_index, kernel) in self.kernel.partitions[channel].iter().enumerate() {
                let history_index = (self.cursor + self.history[channel].len() - partition_index) % self.history[channel].len();
                for bin in 0..FFT_SIZE { scratch[bin] += kernel[bin] * self.history[channel][history_index][bin]; }
            }
            self.ifft.process_with_scratch(scratch, &mut self.ifft_scratch[channel]);
            for index in 0..PARTITION {
                let value = scratch[index].re / FFT_SIZE as f32 + self.overlap[channel][index];
                block[index] = value;
                self.overlap[channel][index] = scratch[index + PARTITION].re / FFT_SIZE as f32;
            }
        }
        self.cursor = (self.cursor + 1) % self.history[0].len();
    }
}
