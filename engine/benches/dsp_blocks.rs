use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use tnd_engine::Dsp;

fn benchmark_blocks(c: &mut Criterion) {
    let mut group = c.benchmark_group("DSP stereo blocks at 48 kHz");
    for frames in [128usize, 256, 512] {
        group.throughput(Throughput::Elements((frames * 2) as u64));
        let mut engine = Dsp::new(48_000);
        let mut buffer = vec![0.05f32; frames * 2];
        group.bench_with_input(BenchmarkId::new("frames", frames), &frames, |bench, _| {
            bench.iter(|| engine.process_block(black_box(&mut buffer)));
        });
    }
    group.finish();
}

criterion_group!(benches, benchmark_blocks);
criterion_main!(benches);
