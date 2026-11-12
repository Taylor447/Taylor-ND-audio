//! Thư viện engine; backend âm thanh có thể đổi mà không ảnh hưởng DSP hoặc giao thức.

pub mod audio;
pub mod dsp;
pub mod protocol;

pub use audio::{list_devices, AudioBackend, AudioSession, AudioSessionControl, DeviceInfo, HotplugWatcher, StartOptions, WasapiCpalBackend};
pub use dsp::{Dsp, EngineProfile, Telemetry};
