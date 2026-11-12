//! Kiểu dữ liệu IPC JSON dùng chung giữa sidecar và Electron.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Auth { token: String },
    ListDevices,
    Start { #[serde(rename = "inputId")] input_id: String, #[serde(rename = "outputId")] output_id: String, #[serde(rename = "bufferMs")] buffer_ms: u32 },
    Stop,
    SetProfile { profile: Value },
    SetBypass { bypass: bool },
    LoadImpulse { path: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage<'a> {
    Devices { devices: &'a [crate::DeviceInfo], #[serde(rename = "cableDetected")] cable_detected: bool },
    State {
        running: bool,
        #[serde(rename = "sampleRate")] sample_rate: u32,
        #[serde(rename = "latencyMs")] latency_ms: f32,
        xruns: u64,
        message: &'a str,
    },
    Telemetry { #[serde(flatten)] data: &'a crate::Telemetry },
    Error { code: &'a str, message: &'a str },
    Ack { request: &'a str, ok: bool, message: &'a str },
}
