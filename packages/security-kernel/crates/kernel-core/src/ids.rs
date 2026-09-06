use core::fmt;

use crate::{KernelError, RandomSource};

pub const OPAQUE_ID_BYTES: usize = 16;

#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct OpaqueId([u8; OPAQUE_ID_BYTES]);

impl OpaqueId {
    pub fn random(source: &mut impl RandomSource) -> Result<Self, KernelError> {
        let mut bytes = [0_u8; OPAQUE_ID_BYTES];
        source.fill_bytes(&mut bytes)?;
        Ok(Self(bytes))
    }

    #[must_use]
    pub const fn from_bytes(bytes: [u8; OPAQUE_ID_BYTES]) -> Self {
        Self(bytes)
    }

    pub fn try_from_slice(bytes: &[u8]) -> Result<Self, KernelError> {
        let bytes: [u8; OPAQUE_ID_BYTES] = bytes
            .try_into()
            .map_err(|_| KernelError::InvalidIdentifier)?;
        Ok(Self(bytes))
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; OPAQUE_ID_BYTES] {
        &self.0
    }
}
impl fmt::Debug for OpaqueId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpaqueId(REDACTED)")
    }
}
