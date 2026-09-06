#![deny(unsafe_op_in_unsafe_fn)]

mod android_jni;

#[cfg(target_os = "android")]
pub use android_jni::unwrap_with_cipher;

use core::fmt;

use kernel_core::{KernelError, LimitProfile, ProtocolCborProfile};

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct KernelFfiError(KernelError);

impl KernelFfiError {
    #[must_use]
    pub const fn stable_code(self) -> &'static str {
        self.0.stable_code()
    }
}

impl fmt::Debug for KernelFfiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.stable_code())
    }
}

impl fmt::Display for KernelFfiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.stable_code())
    }
}

impl std::error::Error for KernelFfiError {}

impl From<KernelError> for KernelFfiError {
    fn from(error: KernelError) -> Self {
        Self(error)
    }
}

pub fn validate_protocol_cbor_bytes(bytes: &[u8]) -> Result<Vec<u8>, KernelFfiError> {
    let document = ProtocolCborProfile::decode(bytes, LimitProfile::V1)?;
    Ok(ProtocolCborProfile::encode(&document)?)
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KernelFfiStatus {
    Ok = 0,
    InvalidInput = 1,
    NonCanonicalInput = 2,
    LimitExceeded = 3,
    Unavailable = 4,
}

impl From<KernelFfiError> for KernelFfiStatus {
    fn from(error: KernelFfiError) -> Self {
        match error.0 {
            KernelError::NonCanonicalEncoding => Self::NonCanonicalInput,
            KernelError::LimitExceeded => Self::LimitExceeded,
            KernelError::InvalidEncoding
            | KernelError::InvalidSecretText
            | KernelError::InvalidIdentifier
            | KernelError::InvalidRecord => Self::InvalidInput,
            _ => Self::Unavailable,
        }
    }
}

/// Validates one typed protocol byte array without returning input or details.
///
/// # Safety
///
/// `bytes` must be non-null. For nonzero `length`, it must identify one readable
/// allocation of at least `length` bytes for this call, and `length` must not
/// exceed `isize::MAX`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn veyora_kernel_validate_protocol_cbor(
    bytes: *const u8,
    length: usize,
) -> KernelFfiStatus {
    if bytes.is_null() {
        return KernelFfiStatus::InvalidInput;
    }
    // SAFETY: upheld by this function's C ABI contract and used only for this
    // synchronous validation call.
    let input = unsafe { core::slice::from_raw_parts(bytes, length) };
    match validate_protocol_cbor_bytes(input) {
        Ok(_) => KernelFfiStatus::Ok,
        Err(error) => error.into(),
    }
}
