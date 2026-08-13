use backend_config::{
    ConfigErrorCode, ConfigLayer, ResolvedBackendConfig, SettingEntry, SettingValue,
    canonical_registry_file_sha256, canonical_setting_count,
};

fn layer(entries: Vec<SettingEntry>) -> ConfigLayer {
    ConfigLayer::new(1, "backend", entries)
}

fn required_owner_values() -> ConfigLayer {
    layer(vec![
        SettingEntry::new(
            "backend.auth.server-identity-key",
            SettingValue::secret_reference("/run/secrets/server-identity"),
        ),
        SettingEntry::new(
            "backend.database.api-password",
            SettingValue::secret_reference("/run/secrets/database-api"),
        ),
        SettingEntry::new(
            "backend.database.backup-password",
            SettingValue::secret_reference("/run/secrets/database-backup"),
        ),
        SettingEntry::new(
            "backend.database.migrator-password",
            SettingValue::secret_reference("/run/secrets/database-migrator"),
        ),
        SettingEntry::new(
            "backend.database.restore-password",
            SettingValue::secret_reference("/run/secrets/database-restore"),
        ),
        SettingEntry::new(
            "backend.database.worker-password",
            SettingValue::secret_reference("/run/secrets/database-worker"),
        ),
        SettingEntry::new(
            "backend.database.ca-file",
            SettingValue::Path("/run/config/postgresql-ca.pem".into()),
        ),
        SettingEntry::new(
            "backend.database.hosts",
            SettingValue::StringList(vec!["db.internal".into()]),
        ),
        SettingEntry::new(
            "backend.database.name",
            SettingValue::String("veyora".into()),
        ),
    ])
}

#[test]
fn canonical_generated_projection_has_all_settings_and_typed_defaults() {
    assert_eq!(canonical_setting_count(), 34);
    assert_eq!(
        canonical_registry_file_sha256(),
        "sha256:f102efca5c3e357404591df28cc80870ef154d3d49ef4e38367e7977e84cf3e6"
    );
    let resolved = ResolvedBackendConfig::load(&required_owner_values(), &layer(vec![]))
        .expect("canonical generated projection");
    assert_eq!(
        resolved.get("backend.database.connect-timeout-seconds"),
        Some(&SettingValue::DurationSeconds(5))
    );
    assert_eq!(
        resolved.get("backend.snapshot.page-max-bytes"),
        Some(&SettingValue::Bytes(4_194_304))
    );
    assert_eq!(
        resolved.get("backend.database.schema"),
        Some(&SettingValue::String("veyora_v1".into()))
    );
}

#[test]
fn command_precedence_uses_the_canonical_generated_type() {
    let command = layer(vec![SettingEntry::new(
        "backend.database.port",
        SettingValue::Integer(6_543),
    )]);
    let resolved = ResolvedBackendConfig::load(&required_owner_values(), &command)
        .expect("valid typed config");
    assert_eq!(
        resolved.get("backend.database.port"),
        Some(&SettingValue::Integer(6_543))
    );
}

#[test]
fn rejects_unknown_duplicate_owner_and_version_inputs() {
    let unknown = layer(vec![SettingEntry::new(
        "backend.database.unknown",
        SettingValue::Integer(1),
    )]);
    let error = ResolvedBackendConfig::load(&required_owner_values(), &unknown)
        .expect_err("unknown setting must fail closed");
    assert_eq!(error.code(), ConfigErrorCode::UnknownSetting);

    let duplicate = layer(vec![
        SettingEntry::new("backend.database.port", SettingValue::Integer(5_432)),
        SettingEntry::new("backend.database.port", SettingValue::Integer(5_433)),
    ]);
    let error = ResolvedBackendConfig::load(&required_owner_values(), &duplicate)
        .expect_err("duplicate setting must fail closed");
    assert_eq!(error.code(), ConfigErrorCode::DuplicateSetting);

    let wrong_owner = ConfigLayer::new(1, "deployment", vec![]);
    let error = ResolvedBackendConfig::load(&required_owner_values(), &wrong_owner)
        .expect_err("wrong owner must fail closed");
    assert_eq!(error.code(), ConfigErrorCode::OwnerMismatch);

    let wrong_version = ConfigLayer::new(2, "backend", vec![]);
    let error = ResolvedBackendConfig::load(&required_owner_values(), &wrong_version)
        .expect_err("wrong version must fail closed");
    assert_eq!(error.code(), ConfigErrorCode::VersionMismatch);
}

#[test]
fn rejects_wrong_types_and_every_generated_constraint_shape() {
    let hostile_values = vec![
        (
            "backend.database.port",
            SettingValue::String("5432".into()),
            ConfigErrorCode::TypeMismatch,
        ),
        (
            "backend.database.port",
            SettingValue::Integer(0),
            ConfigErrorCode::OutOfBounds,
        ),
        (
            "backend.database.connect-timeout-seconds",
            SettingValue::DurationSeconds(16),
            ConfigErrorCode::OutOfBounds,
        ),
        (
            "backend.snapshot.page-max-bytes",
            SettingValue::Bytes(65_535),
            ConfigErrorCode::OutOfBounds,
        ),
        (
            "backend.database.ca-file",
            SettingValue::Path("/tmp/ca.pem".into()),
            ConfigErrorCode::OutOfBounds,
        ),
        (
            "backend.database.name",
            SettingValue::String("Invalid-Name".into()),
            ConfigErrorCode::OutOfBounds,
        ),
        (
            "backend.database.name",
            SettingValue::String("a".repeat(64)),
            ConfigErrorCode::OutOfBounds,
        ),
        (
            "backend.database.tls-mode",
            SettingValue::String("prefer".into()),
            ConfigErrorCode::OutOfBounds,
        ),
        (
            "backend.database.hosts",
            SettingValue::StringList(vec![]),
            ConfigErrorCode::OutOfBounds,
        ),
        (
            "backend.database.hosts",
            SettingValue::StringList((0..9).map(|index| format!("db{index}")).collect()),
            ConfigErrorCode::OutOfBounds,
        ),
        (
            "backend.database.ca-file",
            SettingValue::Path(format!("/run/config/{}", "a".repeat(245))),
            ConfigErrorCode::OutOfBounds,
        ),
    ];
    for (id, value, expected) in hostile_values {
        let command = layer(vec![SettingEntry::new(id, value)]);
        let error = ResolvedBackendConfig::load(&required_owner_values(), &command)
            .expect_err("canonical constraint must fail closed");
        assert_eq!(error.code(), expected, "wrong error for {id}");
    }
}

#[test]
fn rejects_missing_required_generated_values() {
    let error = ResolvedBackendConfig::load(&layer(vec![]), &layer(vec![]))
        .expect_err("required-no-default settings must fail closed");
    assert_eq!(error.code(), ConfigErrorCode::MissingRequired);
}

#[test]
fn validates_secret_reference_shape_without_opening_it() {
    for bad_path in [
        "/tmp/api-role",
        "/run/secrets",
        "/run/secrets/../api-role",
        "/run/secrets//api-role",
        "/run/secrets/api role",
    ] {
        let mut owner = required_owner_values();
        owner.replace(
            "backend.database.api-password",
            SettingValue::secret_reference(bad_path),
        );
        let error = ResolvedBackendConfig::load(&owner, &layer(vec![]))
            .expect_err("unsafe secret reference shape must fail closed");
        assert_eq!(error.code(), ConfigErrorCode::InvalidSecretReference);
    }

    let command_secret = layer(vec![SettingEntry::new(
        "backend.database.api-password",
        SettingValue::secret_reference("/run/secrets/command-role"),
    )]);
    let error = ResolvedBackendConfig::load(&required_owner_values(), &command_secret)
        .expect_err("secret reference belongs only to the owner-file layer");
    assert_eq!(error.code(), ConfigErrorCode::SecretReferenceSource);
}

#[test]
fn debug_output_redacts_all_values_and_secret_paths() {
    let resolved = ResolvedBackendConfig::load(&required_owner_values(), &layer(vec![]))
        .expect("valid typed config");
    let debug = format!("{resolved:?}");
    for sensitive in ["veyora", "db.internal", "/run/secrets/database-api"] {
        assert!(!debug.contains(sensitive), "debug leaked {sensitive}");
    }
    assert!(debug.contains("[REDACTED]"));
}
