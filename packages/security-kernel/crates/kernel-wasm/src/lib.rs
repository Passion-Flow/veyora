#![forbid(unsafe_code)]

use kernel_core::{
    LimitProfile, OsRandomSource, ProtocolCborProfile, RandomSource,
    crypto::{self, AeadKey, AeadNonce},
};

pub fn validate_protocol_cbor_bytes(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    let document = ProtocolCborProfile::decode(bytes, LimitProfile::V1)
        .map_err(kernel_core::KernelError::stable_code)?;
    ProtocolCborProfile::encode(&document).map_err(kernel_core::KernelError::stable_code)
}

/// Argon2id password-key derivation, V1 profile (65,536 KiB / 3 iterations / p=1).
pub fn derive_password_key_bytes(
    password_utf8: &[u8],
    salt: &[u8],
) -> Result<[u8; 32], &'static str> {
    let salt: [u8; 16] = salt.try_into().map_err(|_| {
        kernel_core::KernelError::stable_code(kernel_core::KernelError::InvalidEncoding)
    })?;
    kernel_core::derive_password_key(password_utf8, &salt)
        .map(|key| *key)
        .map_err(kernel_core::KernelError::stable_code)
}

/// Domain-separated record-wrapping key from a root key plus a CBOR context.
pub fn derive_record_key_bytes(
    root_key: &[u8],
    context_cbor: &[u8],
) -> Result<[u8; 32], &'static str> {
    let root: [u8; 32] = root_key.try_into().map_err(|_| {
        kernel_core::KernelError::stable_code(kernel_core::KernelError::CryptographicFailure)
    })?;
    crypto::derive_record_key(&root, context_cbor)
        .map(|key| *key.as_bytes())
        .map_err(kernel_core::KernelError::stable_code)
}

/// XChaCha20-Poly1305 seal. Returns `ciphertext || tag`.
pub fn seal_record_bytes(
    key: &[u8],
    nonce: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, &'static str> {
    let key = AeadKey::from_bytes(key).map_err(kernel_core::KernelError::stable_code)?;
    let nonce: [u8; 24] = nonce.try_into().map_err(|_| {
        kernel_core::KernelError::stable_code(kernel_core::KernelError::InvalidEncoding)
    })?;
    let nonce = AeadNonce::from_bytes(nonce);
    crypto::seal_record(&key, &nonce, aad, plaintext, LimitProfile::V1)
        .map_err(kernel_core::KernelError::stable_code)
}

/// XChaCha20-Poly1305 open. Input is `ciphertext || tag`.
pub fn open_record_bytes(
    key: &[u8],
    nonce: &[u8],
    aad: &[u8],
    ciphertext_and_tag: &[u8],
) -> Result<Vec<u8>, &'static str> {
    let key = AeadKey::from_bytes(key).map_err(kernel_core::KernelError::stable_code)?;
    let nonce: [u8; 24] = nonce.try_into().map_err(|_| {
        kernel_core::KernelError::stable_code(kernel_core::KernelError::InvalidEncoding)
    })?;
    let nonce = AeadNonce::from_bytes(nonce);
    crypto::open_record(&key, &nonce, aad, ciphertext_and_tag, LimitProfile::V1)
        .map(|bytes| bytes.to_vec())
        .map_err(kernel_core::KernelError::stable_code)
}

/// Fresh 24-byte XChaCha20-Poly1305 nonce from the OS CSPRNG.
pub fn generate_nonce_bytes() -> Result<[u8; 24], &'static str> {
    let mut rng = OsRandomSource;
    let mut nonce = [0u8; 24];
    rng.fill_bytes(&mut nonce)
        .map_err(kernel_core::KernelError::stable_code)?;
    Ok(nonce)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = validateProtocolCbor)]
pub fn validate_protocol_cbor(bytes: &[u8]) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    validate_protocol_cbor_bytes(bytes).map_err(wasm_bindgen::JsValue::from_str)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = derivePasswordKey)]
pub fn derive_password_key(password: &[u8], salt: &[u8]) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    derive_password_key_bytes(password, salt)
        .map(Vec::from)
        .map_err(wasm_bindgen::JsValue::from_str)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = deriveRecordKey)]
pub fn derive_record_key(
    root_key: &[u8],
    context_cbor: &[u8],
) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    derive_record_key_bytes(root_key, context_cbor)
        .map(Vec::from)
        .map_err(wasm_bindgen::JsValue::from_str)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = sealRecord)]
pub fn seal_record(
    key: &[u8],
    nonce: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    seal_record_bytes(key, nonce, aad, plaintext).map_err(wasm_bindgen::JsValue::from_str)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = openRecord)]
pub fn open_record(
    key: &[u8],
    nonce: &[u8],
    aad: &[u8],
    ciphertext_and_tag: &[u8],
) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    open_record_bytes(key, nonce, aad, ciphertext_and_tag).map_err(wasm_bindgen::JsValue::from_str)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = generateNonce)]
pub fn generate_nonce() -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    generate_nonce_bytes()
        .map(Vec::from)
        .map_err(wasm_bindgen::JsValue::from_str)
}

/// Generate a 20-character password using the v1 default alphabet.
pub fn generate_password_bytes() -> Result<Vec<u8>, &'static str> {
    let mut rng = OsRandomSource;
    let alphabet = kernel_core::generator::default_alphabet();
    let password = kernel_core::generator::generate_password(&mut rng, &alphabet, 20)
        .map_err(kernel_core::KernelError::stable_code)?;
    Ok(password.as_bytes().to_vec())
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = generatePassword)]
pub fn generate_password() -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    generate_password_bytes().map_err(wasm_bindgen::JsValue::from_str)
}

/// Generate a recovery kit: 32 CSPRNG bytes encoded as the 71-character
/// human form (twelve groups of five, hyphen-separated, Base32+checksum).
pub fn generate_recovery_kit_bytes() -> Result<String, &'static str> {
    let mut entropy = [0u8; 32];
    let mut rng = OsRandomSource;
    rng.fill_bytes(&mut entropy)
        .map_err(kernel_core::KernelError::stable_code)?;
    Ok(kernel_core::recovery::encode_recovery(&entropy))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = generateRecoveryKit)]
pub fn generate_recovery_kit() -> Result<String, wasm_bindgen::JsValue> {
    generate_recovery_kit_bytes().map_err(wasm_bindgen::JsValue::from_str)
}

/// Validate a recovery kit human form and return the 32-byte entropy.
pub fn validate_recovery_kit_bytes(form: &str) -> Result<Vec<u8>, &'static str> {
    kernel_core::recovery::decode_recovery(form)
        .map(|entropy| entropy.to_vec())
        .map_err(kernel_core::KernelError::stable_code)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = validateRecoveryKit)]
pub fn validate_recovery_kit(form: &str) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    validate_recovery_kit_bytes(form).map_err(wasm_bindgen::JsValue::from_str)
}

/// Compute the auth credential identity hash.
pub fn credential_id_hash_bytes(
    method: u32,
    authority_kind: u32,
    authority_id: &[u8],
    raw_credential_id: &[u8],
) -> Result<Vec<u8>, &'static str> {
    kernel_core::auth::credential_id_hash(
        method as u64,
        authority_kind as u64,
        authority_id,
        raw_credential_id,
    )
    .map(|hash| hash.to_vec())
    .map_err(kernel_core::KernelError::stable_code)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = credentialIdHash)]
pub fn credential_id_hash(
    method: u32,
    authority_kind: u32,
    authority_id: &[u8],
    raw_credential_id: &[u8],
) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    credential_id_hash_bytes(method, authority_kind, authority_id, raw_credential_id)
        .map_err(wasm_bindgen::JsValue::from_str)
}

/// Compute the server identity hash (SHA-256 of the server's public key).
pub fn server_identity_hash_bytes(server_public_key: &[u8]) -> Result<Vec<u8>, &'static str> {
    let key: [u8; 32] = server_public_key
        .try_into()
        .map_err(|_| "PM-KERNEL-INVALID-ENCODING")?;
    Ok(kernel_core::auth::server_identity_hash(&key).to_vec())
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = serverIdentityHash)]
pub fn server_identity_hash(server_public_key: &[u8]) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    server_identity_hash_bytes(server_public_key).map_err(wasm_bindgen::JsValue::from_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_surface_preserves_canonical_protocol_bytes_and_redacted_errors() {
        assert_eq!(
            validate_protocol_cbor_bytes(&[0x82, 0x01, 0x41, 0xaa]).unwrap(),
            [0x82, 0x01, 0x41, 0xaa]
        );
        assert_eq!(
            validate_protocol_cbor_bytes(&[0x81, 0x18, 0x01]).unwrap_err(),
            "PM-KERNEL-NONCANONICAL-ENCODING"
        );
    }

    #[test]
    fn crypto_binding_round_trips_end_to_end() {
        let password = b"correct horse battery staple";
        let salt = [0xaa; 16];
        let root = derive_password_key_bytes(password, &salt).unwrap();
        let context = b"\x82\x40\x40"; // inert CBOR context
        let record_key = derive_record_key_bytes(&root, context).unwrap();
        let nonce = generate_nonce_bytes().unwrap();
        let aad = b"pm-v1/record";
        let plaintext = b"inert vault entry".to_vec();
        let sealed = seal_record_bytes(&record_key, &nonce, aad, &plaintext).unwrap();
        assert_eq!(sealed.len(), plaintext.len() + 16);
        let opened = open_record_bytes(&record_key, &nonce, aad, &sealed).unwrap();
        assert_eq!(opened, plaintext);
    }

    #[test]
    fn crypto_binding_redacts_and_fails_closed() {
        let key = [0x01; 32];
        let nonce = [0x02; 24];
        assert_eq!(
            seal_record_bytes(&key, &nonce, b"", b"").unwrap_err(),
            "PM-KERNEL-LIMIT-EXCEEDED"
        );
        // Wrong-length key surfaces a redacted stable code, never a panic.
        let err = seal_record_bytes(&[0x01; 16], &nonce, b"", b"x").unwrap_err();
        assert!(err.starts_with("PM-KERNEL-"));
    }
}
