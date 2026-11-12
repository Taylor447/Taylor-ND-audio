//! Điều khiển PI cho sai khác nhỏ giữa đồng hồ capture và render.

pub struct DriftController {
    target_frames: f64,
    integral: f64,
}

impl DriftController {
    pub fn new(sample_rate: u32, target_ms: f64) -> Self {
        Self { target_frames: sample_rate as f64 * target_ms / 1000.0, integral: 0.0 }
    }

    /// Trả về hệ số nhân cho output/input ratio của rubato.
    pub fn correction(&mut self, queued_frames: usize) -> f64 {
        let error = ((self.target_frames - queued_frames as f64) / self.target_frames.max(1.0)).clamp(-0.25, 0.25);
        self.integral = (self.integral + error * 0.000015).clamp(-0.001, 0.001);
        (error * 0.0007 + self.integral).clamp(-0.001, 0.001)
    }

    pub fn target_frames(&self) -> f64 { self.target_frames }
}

#[cfg(test)]
mod tests {
    use super::DriftController;

    #[test]
    fn pi_resampler_ratio_stays_bounded_and_corrects_clock_drift() {
        let mut controller = DriftController::new(48_000, 10.0);
        let target = controller.target_frames();
        let mut queued = target;
        let mut min_ratio = f64::MAX;
        let mut max_ratio = f64::MIN;
        // Mô phỏng đồng hồ capture nhanh hơn render 100 ppm trong 30 phút audio.
        for _ in 0..(48_000 * 60 * 30 / 256) {
            let correction = controller.correction(queued.max(0.0) as usize);
            let adjusted_output = 256.0 * (1.0 + correction);
            let clock_difference = 256.0 * 0.0001;
            queued = (queued + clock_difference + (adjusted_output - 256.0)).clamp(0.0, 4096.0);
            min_ratio = min_ratio.min(1.0 + correction);
            max_ratio = max_ratio.max(1.0 + correction);
        }
        assert!(min_ratio > 0.999 && max_ratio < 1.001);
        assert!((queued - target).abs() < 200.0, "queue drifted to {queued} frames around target {target}");
    }
}
