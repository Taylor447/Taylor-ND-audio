//! Kiểm tra ABI giống các block mà APO gửi qua Rust.
use tnd_dsp_core::{tnd_create, tnd_destroy, tnd_process, tnd_set_params, TndParams, TND_OK};

#[test]
fn bypass_preserves_each_sample_after_transition() {
    unsafe {
        let handle = tnd_create(48_000, 2);
        assert!(!handle.is_null());
        let mut params = TndParams::default();
        params.bypass = 1;
        assert_eq!(tnd_set_params(handle, &params), TND_OK);
        let mut warmup = vec![0.125_f32; 512 * 2];
        for _ in 0..24 { assert_eq!(tnd_process(handle, warmup.as_mut_ptr(), 512), TND_OK); }
        let mut samples = (0..512 * 2).map(|i| ((i as f32) * 0.017).sin() * 0.4).collect::<Vec<_>>();
        let expected = samples.clone();
        assert_eq!(tnd_process(handle, samples.as_mut_ptr(), 512), TND_OK);
        assert!(samples.iter().zip(expected).all(|(a, b)| a.to_bits() == b.to_bits()));
        tnd_destroy(handle);
    }
}

#[test]
fn invalid_rate_or_channel_layout_is_rejected() {
    unsafe {
        assert!(tnd_create(48_000, 6).is_null());
        assert!(tnd_create(8_000, 2).is_null());
    }
}

#[test]
fn invalid_frame_count_fails_without_touching_memory() {
    unsafe {
        let handle = tnd_create(48_000, 2);
        let mut sample = [0.375_f32; 2];
        assert_ne!(tnd_process(handle, sample.as_mut_ptr(), 513), TND_OK);
        assert_eq!(sample, [0.375; 2]);
        tnd_destroy(handle);
    }
}
