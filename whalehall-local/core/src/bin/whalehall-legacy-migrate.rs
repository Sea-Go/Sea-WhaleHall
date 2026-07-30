use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use serde::Serialize;
use whalehall_local_core::legacy_migration::{
    LegacyMigrationError, build_legacy_migration_plan, cleanup_legacy_files, migrate_legacy_plan,
    verify_legacy_migration,
};
use whalehall_local_core::observations::ObservationJournal;

struct ParsedArguments {
    command: String,
    options: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}

fn main() {
    if let Err(error) = run(env::args().skip(1).collect()) {
        eprintln!("whalehall-legacy-migrate: {error}");
        std::process::exit(2);
    }
}

fn run(arguments: Vec<String>) -> Result<(), LegacyMigrationError> {
    let ParsedArguments {
        command,
        options,
        flags,
    } = parse_arguments(arguments)?;
    match command.as_str() {
        "report" => {
            reject_unknown(
                &options,
                &flags,
                &["legacy-db", "snapshot-at-ms", "output"],
                &[],
            )?;
            let legacy = required_path(&options, "legacy-db")?;
            let snapshot = optional_snapshot(&options)?;
            let plan = build_legacy_migration_plan(&legacy, snapshot)?;
            emit_json(&plan.report, options.get("output").map(Path::new))
        }
        "migrate" => {
            reject_unknown(
                &options,
                &flags,
                &[
                    "legacy-db",
                    "observation-db",
                    "snapshot-at-ms",
                    "confirm-report-hash",
                    "output",
                ],
                &[],
            )?;
            let legacy = required_path(&options, "legacy-db")?;
            let observation = required_path(&options, "observation-db")?;
            let snapshot = required_snapshot(&options)?;
            let confirmed = required(&options, "confirm-report-hash")?;
            let journal = ObservationJournal::open(&observation)?;
            let receipt =
                migrate_legacy_plan(&legacy, &observation, snapshot, confirmed, &journal)?;
            emit_json(&receipt, options.get("output").map(Path::new))
        }
        "verify" => {
            reject_unknown(
                &options,
                &flags,
                &[
                    "legacy-db",
                    "observation-db",
                    "snapshot-at-ms",
                    "confirm-report-hash",
                    "confirm-migration-hash",
                    "output",
                ],
                &[],
            )?;
            let legacy = required_path(&options, "legacy-db")?;
            let observation = required_path(&options, "observation-db")?;
            let snapshot = required_snapshot(&options)?;
            let journal = ObservationJournal::open(&observation)?;
            let receipt = verify_legacy_migration(
                &legacy,
                &observation,
                snapshot,
                required(&options, "confirm-report-hash")?,
                required(&options, "confirm-migration-hash")?,
                &journal,
            )?;
            emit_json(&receipt, options.get("output").map(Path::new))
        }
        "cleanup" => {
            reject_unknown(
                &options,
                &flags,
                &[
                    "legacy-db",
                    "observation-db",
                    "snapshot-at-ms",
                    "confirm-report-hash",
                    "confirm-migration-hash",
                    "confirm-source-stopped",
                    "output",
                ],
                &["delete-legacy"],
            )?;
            if !flags.contains("delete-legacy") {
                return Err(LegacyMigrationError::ConfirmationMismatch(
                    "cleanup is disabled unless --delete-legacy is present".to_owned(),
                ));
            }
            let legacy = required_path(&options, "legacy-db")?;
            let observation = required_path(&options, "observation-db")?;
            let snapshot = required_snapshot(&options)?;
            let report_hash = required(&options, "confirm-report-hash")?;
            let migration_hash = required(&options, "confirm-migration-hash")?;
            let journal = ObservationJournal::open(&observation)?;
            let verified = verify_legacy_migration(
                &legacy,
                &observation,
                snapshot,
                report_hash,
                migration_hash,
                &journal,
            )?;
            drop(journal);
            let receipt = cleanup_legacy_files(
                &legacy,
                &verified,
                report_hash,
                migration_hash,
                required(&options, "confirm-source-stopped")?,
            )?;
            emit_json(&receipt, options.get("output").map(Path::new))
        }
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        _ => Err(LegacyMigrationError::Configuration(format!(
            "unknown command {command:?}; use report, migrate, verify, or cleanup"
        ))),
    }
}

fn parse_arguments(arguments: Vec<String>) -> Result<ParsedArguments, LegacyMigrationError> {
    let mut arguments = arguments.into_iter();
    let command = arguments.next().unwrap_or_else(|| "help".to_owned());
    let mut options = BTreeMap::new();
    let mut flags = BTreeSet::new();
    while let Some(argument) = arguments.next() {
        if !argument.starts_with("--") || argument.len() == 2 {
            return Err(LegacyMigrationError::Configuration(format!(
                "unexpected positional argument {argument:?}"
            )));
        }
        let name = argument.trim_start_matches("--").to_owned();
        if name == "delete-legacy" {
            if !flags.insert(name.clone()) {
                return Err(LegacyMigrationError::Configuration(format!(
                    "duplicate flag --{name}"
                )));
            }
            continue;
        }
        let value = arguments.next().ok_or_else(|| {
            LegacyMigrationError::Configuration(format!("--{name} requires a value"))
        })?;
        if value.starts_with("--") {
            return Err(LegacyMigrationError::Configuration(format!(
                "--{name} requires a value"
            )));
        }
        if options.insert(name.clone(), value).is_some() {
            return Err(LegacyMigrationError::Configuration(format!(
                "duplicate option --{name}"
            )));
        }
    }
    Ok(ParsedArguments {
        command,
        options,
        flags,
    })
}

fn reject_unknown(
    options: &BTreeMap<String, String>,
    flags: &BTreeSet<String>,
    allowed_options: &[&str],
    allowed_flags: &[&str],
) -> Result<(), LegacyMigrationError> {
    if let Some(name) = options
        .keys()
        .find(|name| !allowed_options.contains(&name.as_str()))
    {
        return Err(LegacyMigrationError::Configuration(format!(
            "unknown option --{name}"
        )));
    }
    if let Some(name) = flags
        .iter()
        .find(|name| !allowed_flags.contains(&name.as_str()))
    {
        return Err(LegacyMigrationError::Configuration(format!(
            "unknown flag --{name}"
        )));
    }
    Ok(())
}

fn required<'a>(
    options: &'a BTreeMap<String, String>,
    name: &str,
) -> Result<&'a str, LegacyMigrationError> {
    options
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| LegacyMigrationError::Configuration(format!("missing required --{name}")))
}

fn required_path(
    options: &BTreeMap<String, String>,
    name: &str,
) -> Result<PathBuf, LegacyMigrationError> {
    let path = PathBuf::from(required(options, name)?);
    if !path.is_absolute() {
        return Err(LegacyMigrationError::Configuration(format!(
            "--{name} must be an absolute path"
        )));
    }
    Ok(path)
}

fn required_snapshot(options: &BTreeMap<String, String>) -> Result<i64, LegacyMigrationError> {
    required(options, "snapshot-at-ms")?
        .parse::<i64>()
        .map_err(|_| {
            LegacyMigrationError::Configuration(
                "--snapshot-at-ms must be an integer copied from the report".to_owned(),
            )
        })
}

fn optional_snapshot(options: &BTreeMap<String, String>) -> Result<i64, LegacyMigrationError> {
    match options.get("snapshot-at-ms") {
        Some(value) => value.parse::<i64>().map_err(|_| {
            LegacyMigrationError::Configuration("--snapshot-at-ms must be an integer".to_owned())
        }),
        None => Ok(now_ms()),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn emit_json<T: Serialize>(value: &T, output: Option<&Path>) -> Result<(), LegacyMigrationError> {
    let bytes = serde_json::to_vec_pretty(value)?;
    if let Some(path) = output {
        if !path.is_absolute() {
            return Err(LegacyMigrationError::Configuration(
                "--output must be an absolute path".to_owned(),
            ));
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(path)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    } else {
        let stdout = std::io::stdout();
        let mut stdout = stdout.lock();
        stdout.write_all(&bytes)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

fn print_help() {
    println!(
        r#"WhaleHall legacy EventJournal migration (fail-closed)

report  --legacy-db ABS [--snapshot-at-ms MS] [--output ABS]
migrate --legacy-db ABS --observation-db ABS --snapshot-at-ms MS \
        --confirm-report-hash HASH [--output ABS]
verify  --legacy-db ABS --observation-db ABS --snapshot-at-ms MS \
        --confirm-report-hash HASH --confirm-migration-hash HASH [--output ABS]
cleanup --legacy-db ABS --observation-db ABS --snapshot-at-ms MS \
        --confirm-report-hash HASH --confirm-migration-hash HASH \
        --confirm-source-stopped SOURCE_STOPPED --delete-legacy [--output ABS]

Only metadata-only input buckets and presence boundaries are eligible. Browser,
accessibility, editor, goal, process, and foreground data remain legacy-noise.
Cleanup is never implicit and permanently removes the DB/WAL/SHM files."#
    );
}
