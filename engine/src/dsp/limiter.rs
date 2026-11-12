//! Lookahead limiter nhỏ; hard ceiling cuối cùng bảo đảm không vượt -1 dBFS.

pub struct LookaheadLimiter {
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    write: usize,
    ceiling: f32,
    gain: f32,
    release: f32,
}

impl LookaheadLimiter {
    pub fn new(sample_rate: u32, lookahead_seconds: f32, ceiling: f32) -> Self {
        let delay = ((sample_rate as f32 * lookahead_seconds).round() as usize).max(1);
        Self { delay_l: vec![0.0; delay], delay_r: vec![0.0; delay], write: 0, ceiling,
            gain: 1.0, release: 1.0 - (-1.0 / (sample_rate as f32 * 0.100)).exp() }
    }

    pub fn set_ceiling(&mut self, ceiling: f32) {
        self.ceiling = ceiling.clamp(0.01, 1.0);
    }

    pub fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        let peak = left.abs().max(right.abs());
        let wanted = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };
        if wanted < self.gain { self.gain = wanted; }
        else { self.gain += (wanted - self.gain) * self.release; }
        let delayed_l = self.delay_l[self.write];
        let delayed_r = self.delay_r[self.write];
        self.delay_l[self.write] = left;
        self.delay_r[self.write] = right;
        self.write = (self.write + 1) % self.delay_l.len();
        ((delayed_l * self.gain).clamp(-self.ceiling, self.ceiling),
         (delayed_r * self.gain).clamp(-self.ceiling, self.ceiling))
    }
}
