//! Biquad RBJ và cấu trúc Transposed Direct Form II cho từng kênh.

#[derive(Clone, Copy, Debug)]
pub enum FilterKind { Peak, LowShelf, HighShelf }

#[derive(Clone, Copy, Debug, Default)]
struct Coefficients { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64 }

pub struct Biquad {
    current: Coefficients,
    target: Coefficients,
    z1: [f64; 2],
    z2: [f64; 2],
    smoothing: f64,
}

impl Biquad {
    pub fn new(kind: FilterKind, frequency: f64, gain_db: f64, q: f64, sample_rate: f64) -> Self {
        let target = coefficients(kind, frequency, gain_db, q, sample_rate);
        Self { current: target, target, z1: [0.0; 2], z2: [0.0; 2], smoothing: 1.0 - (-1.0 / (sample_rate * 0.020)).exp() }
    }

    pub fn set_target(&mut self, kind: FilterKind, frequency: f64, gain_db: f64, q: f64, sample_rate: f64) {
        self.target = coefficients(kind, frequency, gain_db, q, sample_rate);
    }

    pub fn advance(&mut self) {
        self.current.b0 += (self.target.b0 - self.current.b0) * self.smoothing;
        self.current.b1 += (self.target.b1 - self.current.b1) * self.smoothing;
        self.current.b2 += (self.target.b2 - self.current.b2) * self.smoothing;
        self.current.a1 += (self.target.a1 - self.current.a1) * self.smoothing;
        self.current.a2 += (self.target.a2 - self.current.a2) * self.smoothing;
    }

    pub fn process(&mut self, channel: usize, input: f32) -> f32 {
        let x = input as f64;
        let y = self.current.b0 * x + self.z1[channel];
        self.z1[channel] = self.current.b1 * x - self.current.a1 * y + self.z2[channel];
        self.z2[channel] = self.current.b2 * x - self.current.a2 * y;
        y as f32
    }

    pub fn response_db(&self, frequency: f64, sample_rate: f64) -> f64 {
        let w = std::f64::consts::TAU * frequency / sample_rate;
        let cos = w.cos(); let sin = w.sin();
        let cos2 = (2.0 * w).cos(); let sin2 = (2.0 * w).sin();
        let c = self.target;
        let numerator = ((c.b0 + c.b1 * cos + c.b2 * cos2).powi(2) + (-c.b1 * sin - c.b2 * sin2).powi(2)).sqrt();
        let denominator = ((1.0 + c.a1 * cos + c.a2 * cos2).powi(2) + (-c.a1 * sin - c.a2 * sin2).powi(2)).sqrt();
        20.0 * (numerator / denominator.max(1e-15)).max(1e-15).log10()
    }
}

fn coefficients(kind: FilterKind, frequency: f64, gain_db: f64, q: f64, sample_rate: f64) -> Coefficients {
    let frequency = frequency.clamp(1.0, sample_rate * 0.49);
    let w0 = std::f64::consts::TAU * frequency / sample_rate;
    let cos = w0.cos(); let sin = w0.sin();
    let a = 10.0_f64.powf(gain_db / 40.0);
    let (b0, b1, b2, a0, a1, a2) = match kind {
        FilterKind::Peak => {
            let alpha = sin / (2.0 * q.max(0.05));
            (1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a,
             1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a)
        }
        FilterKind::LowShelf | FilterKind::HighShelf => {
            let slope = 1.0;
            let alpha = sin * 0.5 * ((a + 1.0 / a) * (1.0 / slope - 1.0) + 2.0).sqrt();
            let beta = 2.0 * a.sqrt() * alpha;
            if matches!(kind, FilterKind::LowShelf) {
                (a * ((a + 1.0) - (a - 1.0) * cos + beta),
                 2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                 a * ((a + 1.0) - (a - 1.0) * cos - beta),
                 (a + 1.0) + (a - 1.0) * cos + beta,
                 -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                 (a + 1.0) + (a - 1.0) * cos - beta)
            } else {
                (a * ((a + 1.0) + (a - 1.0) * cos + beta),
                 -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                 a * ((a + 1.0) + (a - 1.0) * cos - beta),
                 (a + 1.0) - (a - 1.0) * cos + beta,
                 2.0 * ((a - 1.0) - (a + 1.0) * cos),
                 (a + 1.0) - (a - 1.0) * cos - beta)
            }
        }
    };
    Coefficients { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}
