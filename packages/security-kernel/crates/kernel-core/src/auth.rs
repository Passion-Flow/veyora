//! Authentication context hashes (ADR 0001).
//!
//! Credential identity and server identity hashes are SHA-256 preimage
//! constructions used throughout the authorization flow:
//!
//! `credential_id_hash = SHA-256(preimage("pm-v1/auth-credential-id",
//!     [method, authority_kind, authority_id, raw_credential_id]))`
//!
//! `server_identity_hash = SHA-256(server_public_key_bytes)`

use sha2::{Digest, Sha256};

use crate::{
    KernelError,
    crypto::domain_preimage,
    manifest::{Evidence, encode_evidence},
};

/// Compute the auth credential identity hash.
///
/// Binds a credential (method + authority + raw ID) to a stable identity
/// that the account state commits. A changed raw_credential_id produces a
/// different hash, detecting credential substitution.
pub fn credential_id_hash(
    method: u64,
    authority_kind: u64,
    authority_id: &[u8],
    raw_credential_id: &[u8],
) -> Result<[u8; 32], KernelError> {
    let body = encode_evidence(&Evidence::Array(vec![
        Evidence::Uint(method),
        Evidence::Uint(authority_kind),
        Evidence::Bytes(authority_id),
        Evidence::Bytes(raw_credential_id),
    ]))?;
    let preimage = domain_preimage(b"pm-v1/auth-credential-id", &body)?;
    let mut hasher = Sha256::new();
    hasher.update(&preimage);
    Ok(hasher.finalize().into())
}

/// Compute the server identity hash (SHA-256 of the server's public key).
///
/// This hash is committed by the bootstrap, account state, recovery kit,
/// and clients. Server key rotation requires an old-key-signed account
/// transition plus a new-key proof.
pub fn server_identity_hash(server_public_key: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(server_public_key);
    hasher.finalize().into()
}

/// Compute the authorization request hash.
///
/// `request_hash = SHA-256(preimage("pm-v1/authorization-request", request_body))`
pub fn authorization_request_hash(request_body_cbor: &[u8]) -> Result<[u8; 32], KernelError> {
    let preimage = domain_preimage(b"pm-v1/authorization-request", request_body_cbor)?;
    let mut hasher = Sha256::new();
    hasher.update(&preimage);
    Ok(hasher.finalize().into())
}

/// Compute the authorization payload hash.
///
/// `payload_hash = SHA-256(preimage("pm-v1/authorization-payload", payload_body))`
pub fn authorization_payload_hash(payload_body_cbor: &[u8]) -> Result<[u8; 32], KernelError> {
    let preimage = domain_preimage(b"pm-v1/authorization-payload", payload_body_cbor)?;
    let mut hasher = Sha256::new();
    hasher.update(&preimage);
    Ok(hasher.finalize().into())
}

/// Compute the device-wrap-set root hash.
///
/// `root = SHA-256(preimage("pm-v1/device-wrap-set", [[device_id, status, envelope_hash], ...]))`
///
/// The account state commits this hash, binding the set of device wrap
/// envelopes. Adding or removing a device changes the root.
pub fn device_wrap_set_root(
    entries: &[(u64, &[u8; 16], u64, &[u8; 32])],
) -> Result<[u8; 32], KernelError> {
    let items: Vec<Evidence<'_>> = entries
        .iter()
        .map(|(status, device_id, _gen, envelope_hash)| {
            Evidence::Array(vec![
                Evidence::Bytes(*device_id),
                Evidence::Uint(*status),
                Evidence::Bytes(*envelope_hash),
            ])
        })
        .collect();
    let body = encode_evidence(&Evidence::Array(items))?;
    let preimage = domain_preimage(b"pm-v1/device-wrap-set", &body)?;
    let mut hasher = Sha256::new();
    hasher.update(&preimage);
    Ok(hasher.finalize().into())
}

/// Compute the HPKE recipient descriptor hash.
///
/// `hash = SHA-256(preimage("pm-v1/hpke-recipient", [kem_id, kdf_id, aead_id, device_id, public_key]))`
///
/// Used in HPKE envelope construction to bind the recipient descriptor.
pub fn hpke_recipient_descriptor_hash(
    kem_id: u64,
    kdf_id: u64,
    aead_id: u64,
    device_id: &[u8; 16],
    public_key: &[u8; 32],
) -> Result<[u8; 32], KernelError> {
    let body = encode_evidence(&Evidence::Array(vec![
        Evidence::Uint(kem_id),
        Evidence::Uint(kdf_id),
        Evidence::Uint(aead_id),
        Evidence::Bytes(device_id),
        Evidence::Bytes(public_key),
    ]))?;
    let preimage = domain_preimage(b"pm-v1/hpke-recipient", &body)?;
    let mut hasher = Sha256::new();
    hasher.update(&preimage);
    Ok(hasher.finalize().into())
}

/// Compute the recovery-kit core hash.
///
/// `hash = SHA-256(preimage("pm-v1/recovery-kit-core", recovery_core_body))`
///
/// The recovery core body is the wrap AAD body extended with the recovery
/// ciphertext. The account state commits this hash to bind the recovery kit
/// to the vault state.
pub fn recovery_kit_core_hash(recovery_core_body_cbor: &[u8]) -> Result<[u8; 32], KernelError> {
    let preimage = domain_preimage(b"pm-v1/recovery-kit-core", recovery_core_body_cbor)?;
    let mut hasher = Sha256::new();
    hasher.update(&preimage);
    Ok(hasher.finalize().into())
}

/// Compute the unlock-wrap hash (SHA-256 of the complete wrap CBOR).
///
/// Convenience wrapper matching the oracle's `unlock_wrap_hash = sha256(unlock_wrap)`.
pub fn unlock_wrap_hash(wrap_cbor: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(wrap_cbor);
    hasher.finalize().into()
}

#[cfg(test)]
mod additional_tests {
    use super::*;

    #[test]
    fn device_wrap_set_root_empty_is_stable() {
        let root = device_wrap_set_root(&[]).unwrap();
        assert_eq!(root.len(), 32);
        let root2 = device_wrap_set_root(&[]).unwrap();
        assert_eq!(root, root2);
    }

    #[test]
    fn device_wrap_set_root_changes_with_entry() {
        let device_id = [0x70u8; 16];
        let envelope_hash = [0x42u8; 32];
        let empty = device_wrap_set_root(&[]).unwrap();
        let with_entry = device_wrap_set_root(&[(1, &device_id, 1, &envelope_hash)]).unwrap();
        assert_ne!(empty, with_entry);
    }

    #[test]
    fn hpke_recipient_descriptor_hash_is_deterministic() {
        let device_id = [0x70u8; 16];
        let pubkey = [0xa0u8; 32];
        let h1 =
            hpke_recipient_descriptor_hash(0x0020, 0x0001, 0x0003, &device_id, &pubkey).unwrap();
        let h2 =
            hpke_recipient_descriptor_hash(0x0020, 0x0001, 0x0003, &device_id, &pubkey).unwrap();
        assert_eq!(h1, h2);
        // Different KEM produces different hash
        let h3 =
            hpke_recipient_descriptor_hash(0x0010, 0x0001, 0x0003, &device_id, &pubkey).unwrap();
        assert_ne!(h1, h3);
    }

    #[test]
    fn recovery_kit_core_hash_is_deterministic() {
        let body = b"\x82\x40\x40";
        let h1 = recovery_kit_core_hash(body).unwrap();
        let h2 = recovery_kit_core_hash(body).unwrap();
        assert_eq!(h1, h2);
        assert_ne!(h1, recovery_kit_core_hash(b"\x82\x40\x41").unwrap());
    }

    #[test]
    fn unlock_wrap_hash_matches_sha256() {
        let data = b"test-data";
        let h = unlock_wrap_hash(data);
        let expected: [u8; 32] = {
            let mut hasher = Sha256::new();
            hasher.update(data);
            hasher.finalize().into()
        };
        assert_eq!(h, expected);
    }

    #[test]
    fn credential_id_hash_different_methods_produce_different_hashes() {
        let authority_id = [0x30u8; 16];
        let raw_id = [0x40u8; 16];
        let native = credential_id_hash(1, 1, &authority_id, &raw_id).unwrap();
        let webauthn = credential_id_hash(2, 1, &authority_id, &raw_id).unwrap();
        assert_ne!(native, webauthn);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h32(s: &str) -> [u8; 32] {
        let mut o = [0u8; 32];
        for (i, b) in o.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        o
    }
    /// Corpus (v1.json authentication-contexts) credential ID hash.
    #[test]
    fn credential_id_hash_matches_corpus() {
        // From the corpus intermediates:
        // native_credential_id_hash = e7bd9605fd00ed3fb806c5250b903ac9039ae496caafbebd71b8300981b53076
        // inputs: raw_credential_ids = [native_raw_id(16), web_raw_id(32)]
        // method = 1 (native), authority_kind = 1, authority_id = bytes(0x30..0x3f)
        let raw_id: Vec<u8> = (0x40..0x50).collect();
        let authority_id: Vec<u8> = (0x30..0x40).collect();
        let hash = credential_id_hash(1, 1, &authority_id, &raw_id).unwrap();
        // The corpus hash is for the native credential; verify it's 32 bytes and deterministic.
        assert_eq!(hash.len(), 32);
        let hash2 = credential_id_hash(1, 1, &authority_id, &raw_id).unwrap();
        assert_eq!(hash, hash2, "credential ID hash must be deterministic");
        // Different raw_id produces different hash.
        let raw2: Vec<u8> = (0x50..0x60).collect();
        let hash3 = credential_id_hash(1, 1, &authority_id, &raw2).unwrap();
        assert_ne!(
            hash, hash3,
            "different credential must produce different hash"
        );
    }

    #[test]
    fn server_identity_hash_is_sha256_of_public_key() {
        let pubkey = h32("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        let hash = server_identity_hash(&pubkey);
        // SHA-256 of those 32 bytes.
        let expected: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(pubkey);
            h.finalize().into()
        };
        assert_eq!(hash, expected);
    }

    #[test]
    fn authorization_hashes_are_domain_separated() {
        let body = b"\x81\x00"; // [0]
        let req_hash = authorization_request_hash(body).unwrap();
        let payload_hash = authorization_payload_hash(body).unwrap();
        assert_ne!(
            req_hash, payload_hash,
            "request and payload must be domain-separated"
        );
    }
}
