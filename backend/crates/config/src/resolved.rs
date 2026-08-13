use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::generated::{
    GENERATED_CATALOG_VERSION, GENERATED_OWNER, GENERATED_SETTINGS, REGISTRY_FILE_SHA256,
    REGISTRY_PROJECTION_INTEGRITY, REGISTRY_SOURCE_INTEGRITY,
};
use crate::{ConfigError, ConfigErrorCode, GeneratedSettingSpec, GeneratedValueMode, SettingValue};

#[derive(Clone, Eq, PartialEq)]
pub struct SettingEntry {
    id: String,
    value: SettingValue,
}

impl SettingEntry {
    #[must_use]
    pub fn new(id: impl Into<String>, value: SettingValue) -> Self {
        Self {
            id: id.into(),
            value,
        }
    }
}

impl fmt::Debug for SettingEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SettingEntry")
            .field("id", &self.id)
            .field("value", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigLayer {
    catalog_version: u16,
    owner: String,
    entries: Vec<SettingEntry>,
}

impl ConfigLayer {
    #[must_use]
    pub fn new(catalog_version: u16, owner: impl Into<String>, entries: Vec<SettingEntry>) -> Self {
        Self {
            catalog_version,
            owner: owner.into(),
            entries,
        }
    }

    pub fn replace(&mut self, id: &str, value: SettingValue) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) {
            entry.value = value;
        } else {
            self.entries.push(SettingEntry::new(id, value));
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ResolvedBackendConfig {
    values: BTreeMap<String, SettingValue>,
}

impl ResolvedBackendConfig {
    pub fn load(owner_file: &ConfigLayer, command: &ConfigLayer) -> Result<Self, ConfigError> {
        validate_generated_projection()?;
        if owner_file.owner != GENERATED_OWNER || command.owner != GENERATED_OWNER {
            return Err(ConfigError::new(ConfigErrorCode::OwnerMismatch));
        }
        if owner_file.catalog_version != GENERATED_CATALOG_VERSION
            || command.catalog_version != GENERATED_CATALOG_VERSION
        {
            return Err(ConfigError::new(ConfigErrorCode::VersionMismatch));
        }

        let known = GENERATED_SETTINGS
            .iter()
            .map(|specification| (specification.id, specification))
            .collect::<BTreeMap<_, _>>();
        let mut values = BTreeMap::new();
        for specification in GENERATED_SETTINGS {
            if let Some(default) = specification.default_value()? {
                values.insert(specification.id.to_owned(), default);
            }
        }
        apply_layer(owner_file, &known, &mut values, true)?;
        apply_layer(command, &known, &mut values, false)?;

        if GENERATED_SETTINGS.iter().any(|specification| {
            specification.mode == GeneratedValueMode::Required
                && !values.contains_key(specification.id)
        }) {
            return Err(ConfigError::new(ConfigErrorCode::MissingRequired));
        }
        Ok(Self { values })
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<&SettingValue> {
        self.values.get(id)
    }
}

fn validate_generated_projection() -> Result<(), ConfigError> {
    if GENERATED_CATALOG_VERSION != 1
        || GENERATED_OWNER != "backend"
        || GENERATED_SETTINGS.len() != 34
        || [
            REGISTRY_FILE_SHA256,
            REGISTRY_SOURCE_INTEGRITY,
            REGISTRY_PROJECTION_INTEGRITY,
        ]
        .into_iter()
        .any(|digest| !digest.starts_with("sha256:") || digest.len() != 71)
    {
        return Err(ConfigError::new(ConfigErrorCode::InvalidProjection));
    }
    let mut ids = BTreeSet::new();
    for specification in GENERATED_SETTINGS {
        if specification.owner != GENERATED_OWNER
            || !specification.id.starts_with("backend.")
            || !ids.insert(specification.id)
            || (specification.mode == GeneratedValueMode::Default
                && specification.default.is_none())
            || (specification.mode == GeneratedValueMode::Required
                && specification.default.is_some())
        {
            return Err(ConfigError::new(ConfigErrorCode::InvalidProjection));
        }
    }
    Ok(())
}

fn apply_layer(
    layer: &ConfigLayer,
    known: &BTreeMap<&str, &GeneratedSettingSpec>,
    values: &mut BTreeMap<String, SettingValue>,
    permits_secret_references: bool,
) -> Result<(), ConfigError> {
    let mut seen = BTreeSet::new();
    for entry in &layer.entries {
        if !seen.insert(entry.id.as_str()) {
            return Err(ConfigError::new(ConfigErrorCode::DuplicateSetting));
        }
        let Some(specification) = known.get(entry.id.as_str()) else {
            return Err(ConfigError::new(ConfigErrorCode::UnknownSetting));
        };
        if matches!(entry.value, SettingValue::SecretReference(_)) && !permits_secret_references {
            return Err(ConfigError::new(ConfigErrorCode::SecretReferenceSource));
        }
        specification.validate(&entry.value)?;
        values.insert(entry.id.clone(), entry.value.clone());
    }
    Ok(())
}

#[must_use]
pub const fn canonical_setting_count() -> usize {
    GENERATED_SETTINGS.len()
}

#[must_use]
pub const fn canonical_registry_file_sha256() -> &'static str {
    REGISTRY_FILE_SHA256
}

impl fmt::Debug for ResolvedBackendConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedBackendConfig")
            .field("setting_count", &self.values.len())
            .field("values", &"[REDACTED]")
            .finish()
    }
}
