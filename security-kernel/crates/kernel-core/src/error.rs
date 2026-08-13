use core::fmt;

/// A closed, redacted error surface shared by native, WASM, and FFI bindings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum KernelError {
    InvalidEncoding,
    NonCanonicalEncoding,
    LimitExceeded,
    InvalidSecretText,
    InvalidIdentifier,
    InvalidRecord,
    EntropyUnavailable,
    CryptographicFailure,
    Conflict,
    StorageUnavailable,
    ClipboardUnavailable,
    DeviceCredentialUnavailable,
    ClockUnavailable,
}

impl KernelError {
    #[must_use]
    pub const fn invalid_encoding() -> Self {
        Self::InvalidEncoding
    }

    #[must_use]
    pub const fn stable_code(self) -> &'static str {
        match self {
            Self::InvalidEncoding => "PM-KERNEL-INVALID-ENCODING",
            Self::NonCanonicalEncoding => "PM-KERNEL-NONCANONICAL-ENCODING",
            Self::LimitExceeded => "PM-KERNEL-LIMIT-EXCEEDED",
            Self::InvalidSecretText => "PM-KERNEL-INVALID-SECRET-TEXT",
            Self::InvalidIdentifier => "PM-KERNEL-INVALID-IDENTIFIER",
            Self::InvalidRecord => "PM-KERNEL-INVALID-RECORD",
            Self::EntropyUnavailable => "PM-KERNEL-ENTROPY-UNAVAILABLE",
            Self::CryptographicFailure => "PM-KERNEL-CRYPTOGRAPHIC-FAILURE",
            Self::Conflict => "PM-KERNEL-CONFLICT",
            Self::StorageUnavailable => "PM-KERNEL-STORAGE-UNAVAILABLE",
            Self::ClipboardUnavailable => "PM-KERNEL-CLIPBOARD-UNAVAILABLE",
            Self::DeviceCredentialUnavailable => "PM-KERNEL-DEVICE-CREDENTIAL-UNAVAILABLE",
            Self::ClockUnavailable => "PM-KERNEL-CLOCK-UNAVAILABLE",
        }
    }
}

impl fmt::Display for KernelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.stable_code())
    }
}

impl std::error::Error for KernelError {}
