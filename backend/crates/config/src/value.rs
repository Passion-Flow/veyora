use core::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingKind {
    Integer,
    DurationSeconds,
    Bytes,
    String,
    Path,
    StringList,
    SecretReference,
}

#[derive(Clone, Eq, PartialEq)]
pub enum SettingValue {
    Integer(i64),
    DurationSeconds(u64),
    Bytes(u64),
    String(String),
    Path(String),
    StringList(Vec<String>),
    SecretReference(String),
}

impl SettingValue {
    #[must_use]
    pub fn secret_reference(path: impl Into<String>) -> Self {
        Self::SecretReference(path.into())
    }

    pub(crate) fn kind(&self) -> SettingKind {
        match self {
            Self::Integer(_) => SettingKind::Integer,
            Self::DurationSeconds(_) => SettingKind::DurationSeconds,
            Self::Bytes(_) => SettingKind::Bytes,
            Self::String(_) => SettingKind::String,
            Self::Path(_) => SettingKind::Path,
            Self::StringList(_) => SettingKind::StringList,
            Self::SecretReference(_) => SettingKind::SecretReference,
        }
    }
}

impl fmt::Debug for SettingValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::Integer(_) => "Integer",
            Self::DurationSeconds(_) => "DurationSeconds",
            Self::Bytes(_) => "Bytes",
            Self::String(_) => "String",
            Self::Path(_) => "Path",
            Self::StringList(_) => "StringList",
            Self::SecretReference(_) => "SecretReference",
        };
        write!(formatter, "{kind}([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GeneratedValueMode {
    Default,
    Required,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GeneratedDefault {
    Number(i64),
    Text(&'static str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GeneratedConstraints {
    pub(crate) minimum: Option<i64>,
    pub(crate) maximum: Option<i64>,
    pub(crate) minimum_length: Option<usize>,
    pub(crate) maximum_length: Option<usize>,
    pub(crate) minimum_items: Option<usize>,
    pub(crate) maximum_items: Option<usize>,
    pub(crate) pattern: Option<&'static str>,
    pub(crate) allowed: &'static [&'static str],
    pub(crate) reference_type: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GeneratedSettingSpec {
    pub(crate) id: &'static str,
    pub(crate) owner: &'static str,
    pub(crate) kind: SettingKind,
    pub(crate) constraints: GeneratedConstraints,
    pub(crate) mode: GeneratedValueMode,
    pub(crate) default: Option<GeneratedDefault>,
}

impl GeneratedSettingSpec {
    pub(crate) fn default_value(self) -> Result<Option<SettingValue>, ConfigError> {
        let Some(default) = self.default else {
            return Ok(None);
        };
        let value = match (self.kind, default) {
            (SettingKind::Integer, GeneratedDefault::Number(value)) => SettingValue::Integer(value),
            (SettingKind::DurationSeconds, GeneratedDefault::Number(value)) => {
                SettingValue::DurationSeconds(
                    u64::try_from(value)
                        .map_err(|_| ConfigError::new(ConfigErrorCode::InvalidProjection))?,
                )
            }
            (SettingKind::Bytes, GeneratedDefault::Number(value)) => SettingValue::Bytes(
                u64::try_from(value)
                    .map_err(|_| ConfigError::new(ConfigErrorCode::InvalidProjection))?,
            ),
            (SettingKind::String, GeneratedDefault::Text(value)) => {
                SettingValue::String(value.to_owned())
            }
            (SettingKind::Path, GeneratedDefault::Text(value)) => {
                SettingValue::Path(value.to_owned())
            }
            _ => return Err(ConfigError::new(ConfigErrorCode::InvalidProjection)),
        };
        self.validate(&value)?;
        Ok(Some(value))
    }

    pub(crate) fn validate(self, value: &SettingValue) -> Result<(), ConfigError> {
        if value.kind() != self.kind {
            return Err(ConfigError::new(ConfigErrorCode::TypeMismatch));
        }
        match value {
            SettingValue::Integer(value) => self.validate_number(*value),
            SettingValue::DurationSeconds(value) | SettingValue::Bytes(value) => {
                let value = i64::try_from(*value)
                    .map_err(|_| ConfigError::new(ConfigErrorCode::OutOfBounds))?;
                self.validate_number(value)
            }
            SettingValue::String(value) | SettingValue::Path(value) => self.validate_text(value),
            SettingValue::StringList(value) => self.validate_items(value),
            SettingValue::SecretReference(path) => self.validate_secret_reference(path),
        }
    }

    fn validate_number(self, value: i64) -> Result<(), ConfigError> {
        let (Some(minimum), Some(maximum)) = (self.constraints.minimum, self.constraints.maximum)
        else {
            return Err(ConfigError::new(ConfigErrorCode::InvalidProjection));
        };
        if (minimum..=maximum).contains(&value) {
            Ok(())
        } else {
            Err(ConfigError::new(ConfigErrorCode::OutOfBounds))
        }
    }

    fn validate_text(self, value: &str) -> Result<(), ConfigError> {
        if self
            .constraints
            .minimum_length
            .is_some_and(|minimum| value.len() < minimum)
            || self
                .constraints
                .maximum_length
                .is_some_and(|maximum| value.len() > maximum)
            || (!self.constraints.allowed.is_empty() && !self.constraints.allowed.contains(&value))
            || self
                .constraints
                .pattern
                .is_some_and(|pattern| !matches_pattern(pattern, value))
        {
            return Err(ConfigError::new(ConfigErrorCode::OutOfBounds));
        }
        Ok(())
    }

    fn validate_items(self, value: &[String]) -> Result<(), ConfigError> {
        let (Some(minimum), Some(maximum)) = (
            self.constraints.minimum_items,
            self.constraints.maximum_items,
        ) else {
            return Err(ConfigError::new(ConfigErrorCode::InvalidProjection));
        };
        if (minimum..=maximum).contains(&value.len()) {
            Ok(())
        } else {
            Err(ConfigError::new(ConfigErrorCode::OutOfBounds))
        }
    }

    fn validate_secret_reference(self, path: &str) -> Result<(), ConfigError> {
        if self.constraints.reference_type != Some("mounted-file")
            || self.constraints.allowed != ["mounted-file"]
        {
            return Err(ConfigError::new(ConfigErrorCode::InvalidProjection));
        }
        if valid_secret_reference(path) {
            Ok(())
        } else {
            Err(ConfigError::new(ConfigErrorCode::InvalidSecretReference))
        }
    }
}

fn matches_pattern(pattern: &str, value: &str) -> bool {
    match pattern {
        "^/run/config/" => valid_config_path(value),
        "^[a-z][a-z0-9_]*$" => {
            let mut bytes = value.bytes();
            bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
                && bytes
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        }
        _ => false,
    }
}

fn valid_config_path(path: &str) -> bool {
    valid_mounted_path(path, "/run/config/")
}

fn valid_secret_reference(path: &str) -> bool {
    valid_mounted_path(path, "/run/secrets/") && path.len() <= 268
}

fn valid_mounted_path(path: &str, prefix: &str) -> bool {
    let Some(relative) = path.strip_prefix(prefix) else {
        return false;
    };
    !relative.is_empty()
        && relative.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigErrorCode {
    UnknownSetting,
    DuplicateSetting,
    OwnerMismatch,
    VersionMismatch,
    TypeMismatch,
    OutOfBounds,
    InvalidSecretReference,
    SecretReferenceSource,
    MissingRequired,
    InvalidProjection,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ConfigError {
    code: ConfigErrorCode,
}

impl ConfigError {
    pub(crate) const fn new(code: ConfigErrorCode) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(&self) -> ConfigErrorCode {
        self.code
    }
}

impl fmt::Debug for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfigError")
            .field("code", &self.code)
            .field("value", &"[REDACTED]")
            .finish()
    }
}
