#![forbid(unsafe_code)]

pub mod account_state;
pub mod auth;
pub mod codec;
pub mod contracts_generated;
pub mod crypto;
mod error;
pub mod generator;
mod ids;
mod limits;
pub mod manifest;
mod ports;
pub mod recovery;
pub mod session;
pub mod unlock;

use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroizing;

pub use codec::{
    CanonicalCodec, CanonicalProtocolCbor, CanonicalWebAuthnCbor, ProtocolCborProfile,
    WebAuthnCborKind, WebAuthnCborProfile,
};
pub use error::KernelError;
pub use ids::{OPAQUE_ID_BYTES, OpaqueId};
pub use limits::{LimitProfile, MAX_OPAQUE_TEXT_BYTES};
pub use ports::{
    ClearOutcome, Clipboard, ClipboardReceipt, Clock, DeviceAssurance, DeviceCredential,
    DevicePolicy, EncryptedStore, OsRandomSource, RandomSource, WrappedDeviceKey,
};

#[derive(Clone)]
pub struct OpaqueSecret(Zeroizing<Vec<u8>>);

impl core::fmt::Debug for OpaqueSecret {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str("OpaqueSecret(REDACTED)")
    }
}

pub fn encode_opaque_secret(bytes: &[u8]) -> Result<OpaqueSecret, KernelError> {
    if bytes.is_empty() || bytes.len() > LimitProfile::V1.max_secret_text_bytes() {
        return Err(KernelError::LimitExceeded);
    }
    core::str::from_utf8(bytes).map_err(|_| KernelError::InvalidSecretText)?;
    Ok(OpaqueSecret(Zeroizing::new(bytes.to_vec())))
}

pub fn decode_opaque_secret(secret: &OpaqueSecret) -> Result<Zeroizing<Vec<u8>>, KernelError> {
    Ok(Zeroizing::new(secret.0.to_vec()))
}

pub fn derive_password_key(
    password_utf8: &[u8],
    salt: &[u8; 16],
) -> Result<Zeroizing<[u8; 32]>, KernelError> {
    let password = encode_opaque_secret(password_utf8)?;
    let params =
        Params::new(65_536, 3, 1, Some(32)).map_err(|_| KernelError::CryptographicFailure)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = Zeroizing::new([0_u8; 32]);
    argon2
        .hash_password_into(password.0.as_ref(), salt, output.as_mut())
        .map_err(|_| KernelError::CryptographicFailure)?;
    Ok(output)
}

pub fn validate_generic_record(
    record: &contracts_generated::GenericEncryptedRecordV1,
    _limits: LimitProfile,
) -> Result<(), KernelError> {
    if record.protocol_version != contracts_generated::PROTOCOL_VERSION
        || record.suite_id != contracts_generated::SUITE_ID
        || record.revision == 0
        || record.ciphertext.is_empty()
        || !is_valid_record_ciphertext_length(record.ciphertext_length)
        || u64::try_from(record.ciphertext.len()).ok() != Some(record.ciphertext_length)
        || !is_lower_hex(&record.deployment_id, 32)
        || !is_lower_hex(&record.vault_id, 32)
        || !is_lower_hex(&record.record_id, 32)
        || !is_lower_hex(&record.ciphertext_hash, 64)
        || !is_lower_hex(&record.template_envelope_hash, 64)
        || !is_lower_hex(&record.manifest_binding, 64)
    {
        return Err(KernelError::InvalidRecord);
    }
    Ok(())
}

fn is_valid_record_ciphertext_length(ciphertext_length: u64) -> bool {
    const TAG_BYTES: u64 = 16;

    if ciphertext_length > contracts_generated::RECORD_CIPHERTEXT_MAX_BYTES {
        return false;
    }
    let Some(bucket) = ciphertext_length.checked_sub(TAG_BYTES) else {
        return false;
    };
    if !(1_024..=contracts_generated::RECORD_PLAINTEXT_BUCKET_MAX_BYTES).contains(&bucket) {
        return false;
    }
    if bucket <= 4_096 {
        bucket.is_multiple_of(1_024)
    } else if bucket <= 65_536 {
        bucket.is_multiple_of(4_096)
    } else {
        bucket.is_power_of_two()
    }
}

fn is_lower_hex(value: &str, expected_length: usize) -> bool {
    value.len() == expected_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
