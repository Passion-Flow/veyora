use core::fmt;

use zeroize::Zeroizing;

use crate::{KernelError, OpaqueId};

pub trait RandomSource {
    fn fill_bytes(&mut self, out: &mut [u8]) -> Result<(), KernelError>;
}

#[derive(Debug, Default)]
pub struct OsRandomSource;

impl RandomSource for OsRandomSource {
    fn fill_bytes(&mut self, out: &mut [u8]) -> Result<(), KernelError> {
        getrandom::fill(out).map_err(|_| KernelError::EntropyUnavailable)
    }
}

pub trait EncryptedStore {
    fn read_generation(&self, id: OpaqueId) -> Result<Option<Vec<u8>>, KernelError>;
    fn commit_generation(&self, expected: Option<u64>, bytes: &[u8]) -> Result<u64, KernelError>;
}

#[derive(Clone, Eq, PartialEq)]
pub struct ClipboardReceipt([u8; 16]);

impl ClipboardReceipt {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

impl fmt::Debug for ClipboardReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ClipboardReceipt(REDACTED)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClearOutcome {
    Cleared,
    NotOwned,
    AlreadyEmpty,
}

pub trait Clipboard {
    fn write_secret(&mut self, value: &[u8]) -> Result<ClipboardReceipt, KernelError>;
    fn clear_if_owned(&mut self, receipt: &ClipboardReceipt) -> Result<ClearOutcome, KernelError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DevicePolicy {
    UserPresence,
    UserVerification,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceAssurance {
    Unavailable,
    SoftwareBacked,
    HardwareBacked,
}

#[derive(Clone, Eq, PartialEq)]
pub struct WrappedDeviceKey(Vec<u8>);

impl WrappedDeviceKey {
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, KernelError> {
        if bytes.is_empty() || bytes.len() > 4_096 {
            return Err(KernelError::LimitExceeded);
        }
        Ok(Self(bytes))
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for WrappedDeviceKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WrappedDeviceKey(REDACTED)")
    }
}

pub trait DeviceCredential {
    fn wrap(
        &mut self,
        key: &[u8; 32],
        policy: DevicePolicy,
    ) -> Result<WrappedDeviceKey, KernelError>;
    fn unwrap(&mut self, wrapped: &WrappedDeviceKey) -> Result<Zeroizing<[u8; 32]>, KernelError>;
    fn assurance(&self) -> DeviceAssurance;
}

pub trait Clock {
    fn unix_time_millis(&self) -> Result<u64, KernelError>;
}
