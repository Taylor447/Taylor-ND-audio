//! Bộ thăm dò độc lập: liệt kê endpoint audio và trả JSON, không sửa registry hay driver.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeReport {
    schema_version: u32,
    system: SystemInfo,
    devices: Vec<ProbeDevice>,
    software_conflicts: Vec<String>,
    notice: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    architecture: String,
    windows_build: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeDevice {
    endpoint_id: String,
    name: String,
    direction: String,
    device_type: String,
    bus: String,
    vendor: Option<String>,
    driver_version: Option<String>,
    driver_date: Option<String>,
    inf_name: Option<String>,
    hardware_id: Option<String>,
    inbox_driver: Option<bool>,
    sample_rate: Option<u32>,
    channels: Option<u16>,
    sample_format: Option<String>,
    exclusive_mode_available: Option<bool>,
    spatial_audio: Option<String>,
    enhancements_disabled: Option<bool>,
    processing_modes: Vec<String>,
    ap_os: Vec<serde_json::Value>,
}

fn classify(name: &str) -> (&'static str, &'static str) {
    let lower = name.to_ascii_lowercase();
    if lower.contains("bluetooth") || lower.contains("a2dp") || lower.contains("hands-free") { ("bluetooth", "bluetooth") }
    else if lower.contains("hdmi") || lower.contains("displayport") || lower.contains("display audio") { ("hdmi-displayport", "display") }
    else if lower.contains("usb") { ("usb", "usb") }
    else if lower.contains("cable") || lower.contains("virtual") || lower.contains("voicemeeter") { ("virtual", "virtual") }
    else if lower.contains("headphone") || lower.contains("headset") || lower.contains("earphone") { ("headphones", "unknown") }
    else { ("speaker-or-audio", "unknown") }
}

fn run() -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let mut devices = Vec::new();
    for (direction, result) in [("input", host.input_devices()), ("output", host.output_devices())] {
        let collection = result.map_err(|error| error.to_string())?;
        for device in collection {
            let name = device.to_string();
            let endpoint_id = device.id().map(|id| id.to_string()).unwrap_or_else(|_| name.clone());
            let config = if direction == "input" { device.default_input_config() } else { device.default_output_config() };
            let (sample_rate, channels, sample_format) = config.map(|value| (
                Some(value.sample_rate().0), Some(value.channels()), Some(format!("{:?}", value.sample_format()))
            )).unwrap_or((None, None, None));
            let (device_type, bus) = classify(&name);
            devices.push(ProbeDevice {
                endpoint_id, name, direction: direction.to_owned(), device_type: device_type.to_owned(), bus: bus.to_owned(),
                vendor: None, driver_version: None, driver_date: None, inf_name: None, hardware_id: None,
                inbox_driver: None, sample_rate, channels, sample_format, exclusive_mode_available: None,
                spatial_audio: None, enhancements_disabled: None, processing_modes: Vec::new(), ap_os: Vec::new(),
            });
        }
    }
    let report = ProbeReport {
        schema_version: 1,
        system: SystemInfo { architecture: std::env::consts::ARCH.to_owned(), windows_build: None },
        devices,
        software_conflicts: Vec::new(),
        notice: "Endpoint và định dạng lấy từ CPAL. Trường PnP/SetupAPI, APO, Spatial Sound, enhancements và phần mềm xung đột hiện để trống/chưa xác định; không suy đoán hoặc tự sửa registry.".to_owned(),
    };
    println!("{}", serde_json::to_string(&report).map_err(|error| error.to_string())?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Không thăm dò được thiết bị audio: {error}");
        std::process::exit(1);
    }
}
