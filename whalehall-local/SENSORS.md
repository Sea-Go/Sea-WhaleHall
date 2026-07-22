# Rust Sensors

Every client sensor has exactly one public entry file under `core/src/sensors/`:

| Sensor file | Collection model | Agent Tools |
| --- | --- | --- |
| `activity.rs` | Resident foreground-application monitor | `activity.status`, `activity.sessions`, `activity.cleanup` |
| `device_environment.rs` | On-demand device snapshot | `device.environment` |

`sensors/mod.rs` is only the registry. A new sensor is added as one sibling `.rs` file and exported there. Tool protocol adaptation stays under `core/src/tools/`, so sensor APIs remain usable directly from Rust without JSON.

The activity entry file delegates to a private multi-file SQLite engine because it owns a long-running state machine, schema, crash recovery, and retention. Those files are implementation support rather than separately registered sensors.

## Device and environment snapshot

Rust callers use:

```rust
use whalehall_local_core::sensors::device_environment::DeviceEnvironmentSensor;

let snapshot = DeviceEnvironmentSensor.collect();
```

Agent callers use:

```json
{"id":"device-1","method":"tool.call","params":{"name":"device.environment","arguments":{}}}
```

The snapshot includes:

- operating-system name/version, kernel version, and architecture;
- device name and local username;
- preferred languages and IANA timezone with current UTC offset;
- display count, position, pixel resolution, scale, refresh rate, and primary/builtin flags;
- CPU brand/vendor, architecture, logical/physical core counts, and frequency;
- total, available, and used memory in bytes;
- battery charge, health, state, cycle count, and remaining-time estimates when available;
- network-interface name/index, loopback state, MAC address, IP addresses, and netmasks.

Collection is best-effort. Missing batteries are represented by an empty list. Components that cannot be queried add an item to `warnings` while all other fields remain available. The Tool requires `device.environment.read` because device name, username, MAC, and IP addresses are sensitive local information.

## Mandatory CI/CD gate

Every public sensor file must have one native CI probe in `tests/native-integration.test.ts`. The test discovers all sibling `.rs` files under `core/src/sensors/` (excluding the registry `mod.rs`) and compares them with the probe table. Adding, renaming, or removing a sensor without updating its probe fails CI.

Each probe must call the sensor through the real packaged JSONL server and assert meaningful output, not only confirm that the Rust code compiles. Probe Tool names and call IDs must be unique. The GitHub Actions matrix runs this gate independently on macOS ARM64, Windows x64, and Linux x64 before packaging or artifact upload.

To add a sensor:

1. add its single public entry file under `core/src/sensors/` and export it from `sensors/mod.rs`;
2. expose an Agent-callable Tool suitable for a non-destructive CI probe;
3. add exactly one entry to `sensorCiProbes` with platform-safe output assertions;
4. run `bun run test:sensors:ci` locally when practical, then require all three GitHub Actions matrix jobs to pass before merging or releasing.

Hosted runners can lack an interactive display, battery, or foreground window. A probe must validate successful collection and the component's degraded-state contract on such machines; hardware-dependent values may be empty only when the sensor returns an explicit warning or documented empty representation.
