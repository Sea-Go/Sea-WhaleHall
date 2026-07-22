//! On-demand device and environment sensor.
//!
//! Collection is best-effort: an unavailable display server, battery subsystem,
//! network stack, or locale source is reported in `warnings` without hiding the
//! other device information.

use battery::units::ratio::percent;
use battery::units::time::second;
use battery::{Manager as BatteryManager, State as BatteryState};
use chrono::{Local, SecondsFormat, Utc};
use display_info::DisplayInfo;
use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig};
use serde::Serialize;
use sysinfo::System;

#[derive(Clone, Copy, Debug, Default)]
pub struct DeviceEnvironmentSensor;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEnvironmentSnapshot {
    pub collected_at_ms: i64,
    pub collected_at: String,
    pub operating_system: OperatingSystemInfo,
    pub device_name: Option<String>,
    pub local_username: Option<String>,
    pub languages: Vec<String>,
    pub timezone: TimezoneInfo,
    pub screen_count: usize,
    pub screens: Vec<ScreenInfo>,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub batteries: Vec<BatteryInfo>,
    pub network_interfaces: Vec<NetworkInterfaceInfo>,
    pub warnings: Vec<SensorWarning>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperatingSystemInfo {
    pub name: String,
    pub version: Option<String>,
    pub long_version: Option<String>,
    pub kernel_version: Option<String>,
    pub architecture: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimezoneInfo {
    pub name: Option<String>,
    pub utc_offset_minutes: i32,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width_px: u32,
    pub height_px: u32,
    pub scale_factor: f32,
    pub refresh_rate_hz: Option<f32>,
    pub is_primary: bool,
    pub is_builtin: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub brand: Option<String>,
    pub vendor: Option<String>,
    pub architecture: String,
    pub logical_cores: usize,
    pub physical_cores: Option<usize>,
    pub frequency_mhz: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatteryInfo {
    pub state: String,
    pub charge_percent: f32,
    pub health_percent: f32,
    pub cycle_count: Option<u32>,
    pub time_to_full_seconds: Option<f32>,
    pub time_to_empty_seconds: Option<f32>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub index: u32,
    pub is_internal: bool,
    pub mac_address: Option<String>,
    pub addresses: Vec<NetworkAddressInfo>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAddressInfo {
    pub family: String,
    pub address: String,
    pub netmask: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SensorWarning {
    pub component: String,
    pub message: String,
}

impl DeviceEnvironmentSensor {
    pub fn collect(&self) -> DeviceEnvironmentSnapshot {
        let collected_at = Utc::now();
        let mut warnings = Vec::new();
        let system = System::new_all();

        let (mut languages, language_error) = match whoami::lang_prefs() {
            Ok(preferences) => (
                preferences
                    .message_langs()
                    .map(|language| normalize_language(&language.to_string()))
                    .collect::<Vec<_>>(),
                None,
            ),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        if languages.is_empty()
            && let Some(language) = sys_locale::get_locale()
                .as_deref()
                .and_then(non_empty)
                .map(|language| normalize_language(&language))
        {
            languages.push(language);
        }
        if languages.is_empty() {
            warnings.push(SensorWarning {
                component: "language".to_owned(),
                message: language_error
                    .unwrap_or_else(|| "the operating system returned no locale".to_owned()),
            });
        }

        let screens = collect_screens(&mut warnings);
        let batteries = collect_batteries(&mut warnings);
        let network_interfaces = collect_network_interfaces(&mut warnings);
        let cpu = collect_cpu(&system);
        let total_memory = system.total_memory();
        let available_memory = system.available_memory();

        DeviceEnvironmentSnapshot {
            collected_at_ms: collected_at.timestamp_millis(),
            collected_at: collected_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            operating_system: OperatingSystemInfo {
                name: System::name().unwrap_or_else(|| std::env::consts::OS.to_owned()),
                version: System::os_version(),
                long_version: System::long_os_version(),
                kernel_version: System::kernel_version(),
                architecture: System::cpu_arch(),
            },
            device_name: optional_identity(whoami::devicename(), "deviceName", &mut warnings),
            local_username: optional_identity(whoami::username(), "localUsername", &mut warnings),
            languages,
            timezone: TimezoneInfo {
                name: iana_time_zone::get_timezone()
                    .map_err(|error| {
                        warnings.push(warning("timezone", error));
                    })
                    .ok(),
                utc_offset_minutes: Local::now().offset().local_minus_utc() / 60,
            },
            screen_count: screens.len(),
            screens,
            cpu,
            memory: MemoryInfo {
                total_bytes: total_memory,
                available_bytes: available_memory,
                used_bytes: total_memory.saturating_sub(available_memory),
            },
            batteries,
            network_interfaces,
            warnings,
        }
    }
}

fn collect_cpu(system: &System) -> CpuInfo {
    let first = system.cpus().first();
    CpuInfo {
        brand: first.and_then(|cpu| non_empty(cpu.brand())),
        vendor: first.and_then(|cpu| non_empty(cpu.vendor_id())),
        architecture: System::cpu_arch(),
        logical_cores: system.cpus().len(),
        physical_cores: System::physical_core_count(),
        frequency_mhz: system
            .cpus()
            .iter()
            .map(|cpu| cpu.frequency())
            .max()
            .filter(|frequency| *frequency > 0),
    }
}

fn collect_screens(warnings: &mut Vec<SensorWarning>) -> Vec<ScreenInfo> {
    let mut screens = match DisplayInfo::all() {
        Ok(displays) => displays
            .into_iter()
            .map(|display| ScreenInfo {
                id: display.id,
                name: if display.friendly_name.is_empty() {
                    display.name
                } else {
                    display.friendly_name
                },
                x: display.x,
                y: display.y,
                width_px: display.width,
                height_px: display.height,
                scale_factor: display.scale_factor,
                refresh_rate_hz: (display.frequency > 0.0).then_some(display.frequency),
                is_primary: display.is_primary,
                is_builtin: display.is_builtin,
            })
            .collect::<Vec<_>>(),
        Err(error) => {
            warnings.push(warning("screens", error));
            Vec::new()
        }
    };
    screens.sort_by_key(|screen| (!screen.is_primary, screen.id));
    screens
}

fn collect_batteries(warnings: &mut Vec<SensorWarning>) -> Vec<BatteryInfo> {
    let manager = match BatteryManager::new() {
        Ok(manager) => manager,
        Err(error) => {
            warnings.push(warning("battery", error));
            return Vec::new();
        }
    };
    let batteries = match manager.batteries() {
        Ok(batteries) => batteries,
        Err(error) => {
            warnings.push(warning("battery", error));
            return Vec::new();
        }
    };

    batteries
        .filter_map(|battery| match battery {
            Ok(battery) => Some(BatteryInfo {
                state: battery_state(battery.state()).to_owned(),
                charge_percent: battery.state_of_charge().get::<percent>(),
                health_percent: battery.state_of_health().get::<percent>(),
                cycle_count: battery.cycle_count(),
                time_to_full_seconds: battery.time_to_full().map(|time| time.get::<second>()),
                time_to_empty_seconds: battery.time_to_empty().map(|time| time.get::<second>()),
            }),
            Err(error) => {
                warnings.push(warning("battery", error));
                None
            }
        })
        .collect()
}

fn collect_network_interfaces(warnings: &mut Vec<SensorWarning>) -> Vec<NetworkInterfaceInfo> {
    let mut interfaces = match NetworkInterface::show() {
        Ok(interfaces) => interfaces
            .into_iter()
            .map(|interface| NetworkInterfaceInfo {
                name: interface.name,
                index: interface.index,
                is_internal: interface.internal,
                mac_address: interface.mac_addr.filter(|value| !value.is_empty()),
                addresses: interface
                    .addr
                    .into_iter()
                    .map(|address| NetworkAddressInfo {
                        family: match address {
                            Addr::V4(_) => "ipv4",
                            Addr::V6(_) => "ipv6",
                        }
                        .to_owned(),
                        address: address.ip().to_string(),
                        netmask: address.netmask().map(|netmask| netmask.to_string()),
                    })
                    .collect(),
            })
            .collect::<Vec<_>>(),
        Err(error) => {
            warnings.push(warning("networkInterfaces", error));
            Vec::new()
        }
    };
    interfaces.sort_by(|left, right| {
        left.index
            .cmp(&right.index)
            .then(left.name.cmp(&right.name))
    });
    interfaces
}

fn optional_identity<E: std::fmt::Display>(
    result: Result<String, E>,
    component: &str,
    warnings: &mut Vec<SensorWarning>,
) -> Option<String> {
    match result {
        Ok(value) => non_empty(&value),
        Err(error) => {
            warnings.push(warning(component, error));
            None
        }
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn battery_state(state: BatteryState) -> &'static str {
    match state {
        BatteryState::Charging => "charging",
        BatteryState::Discharging => "discharging",
        BatteryState::Empty => "empty",
        BatteryState::Full => "full",
        _ => "unknown",
    }
}

fn warning(component: &str, error: impl std::fmt::Display) -> SensorWarning {
    SensorWarning {
        component: component.to_owned(),
        message: error.to_string(),
    }
}

fn normalize_language(value: &str) -> String {
    value
        .split(['.', '@'])
        .next()
        .unwrap_or(value)
        .replace(['/', '_'], "-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_required_device_environment_sections() {
        let snapshot = DeviceEnvironmentSensor.collect();
        assert!(!snapshot.operating_system.name.is_empty());
        assert!(!snapshot.operating_system.architecture.is_empty());
        assert!(snapshot.memory.total_bytes > 0);
        assert!(snapshot.memory.used_bytes <= snapshot.memory.total_bytes);
        assert_eq!(snapshot.screen_count, snapshot.screens.len());
        assert!(snapshot.collected_at_ms > 0);
    }

    #[test]
    fn normalizes_empty_optional_values() {
        assert_eq!(non_empty("  "), None);
        assert_eq!(non_empty(" value "), Some("value".to_owned()));
        assert_eq!(normalize_language("zh/CN.UTF-8"), "zh-CN");
        assert_eq!(normalize_language("en_US"), "en-US");
    }
}
