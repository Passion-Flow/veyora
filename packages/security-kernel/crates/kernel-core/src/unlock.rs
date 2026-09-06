//! Vault root-key unlock wrapping (ADR 0001).
//!
//! The vault root key is sealed under a key derived from the Argon2id password
//! hash, so the client can unlock the vault with the master password. Each
//! generation's wrap is a CBOR array `[1, 1, deployment, vault, generation, salt,
//! kib_memory, iterations, parallelism, nonce, ciphertext]` where ciphertext is
//! `XChaCha20-Poly1305(wrap_key, nonce, aad, root)`.
//!
//! `wrap_key = KDF("pm-v1/unlock-wrap-key", argon2id_output, [deployment, vault, generation])`
//! `aad = preimage("pm-v1/unlock-wrap", aad_body_without_ciphertext)`

use sha2::{Digest, Sha256};

use crate::{
    KernelError, LimitProfile,
    crypto::{self, AeadKey, AeadNonce},
    manifest::{Evidence, encode_evidence},
};

/// The AAD body fields (everything except the final ciphertext).
#[derive(Clone, Debug)]
pub struct UnlockWrapAad<'a> {
    pub deployment_id: &'a [u8; 16],
    pub vault_id: &'a [u8; 16],
    pub generation: u64,
    pub salt: &'a [u8; 16],
    pub kib_memory: u64,
    pub iterations: u64,
    pub parallelism: u64,
    pub nonce: &'a [u8; 24],
}

/// Derive the unlock wrap key from the Argon2id output and binding context.
pub fn derive_unlock_key(
    argon2id_output: &[u8; 32],
    deployment_id: &[u8; 16],
    vault_id: &[u8; 16],
    generation: u64,
) -> Result<AeadKey, KernelError> {
    let context = encode_evidence(&Evidence::Array(vec![
        Evidence::Bytes(deployment_id),
        Evidence::Bytes(vault_id),
        Evidence::Uint(generation),
    ]))?;
    let raw = crypto::kdf(b"pm-v1/unlock-wrap-key", argon2id_output, &context)?;
    AeadKey::from_bytes(&raw)
}

fn aad_preimage(aad: &UnlockWrapAad<'_>) -> Result<Vec<u8>, KernelError> {
    let body = encode_evidence(&Evidence::Array(vec![
        Evidence::Uint(1),
        Evidence::Uint(1),
        Evidence::Bytes(aad.deployment_id),
        Evidence::Bytes(aad.vault_id),
        Evidence::Uint(aad.generation),
        Evidence::Bytes(aad.salt),
        Evidence::Uint(aad.kib_memory),
        Evidence::Uint(aad.iterations),
        Evidence::Uint(aad.parallelism),
        Evidence::Bytes(aad.nonce),
    ]))?;
    crypto::domain_preimage(b"pm-v1/unlock-wrap", &body)
}

/// Seal the 32-byte vault root key under the password-derived unlock key.
/// Returns the complete wrap CBOR (the aad_body extended with the ciphertext).
pub fn seal_unlock_wrap(
    unlock_key: &AeadKey,
    aad: &UnlockWrapAad<'_>,
    root_key: &[u8; 32],
) -> Result<Vec<u8>, KernelError> {
    let nonce = AeadNonce::from_bytes(*aad.nonce);
    let aad_bytes = aad_preimage(aad)?;
    let ciphertext =
        crypto::seal_record(unlock_key, &nonce, &aad_bytes, root_key, LimitProfile::V1)?;
    // wrap = cbor([1, 1, deployment, vault, generation, salt, kib, iter, par, nonce, ciphertext])
    encode_evidence(&Evidence::Array(vec![
        Evidence::Uint(1),
        Evidence::Uint(1),
        Evidence::Bytes(aad.deployment_id),
        Evidence::Bytes(aad.vault_id),
        Evidence::Uint(aad.generation),
        Evidence::Bytes(aad.salt),
        Evidence::Uint(aad.kib_memory),
        Evidence::Uint(aad.iterations),
        Evidence::Uint(aad.parallelism),
        Evidence::Bytes(aad.nonce),
        Evidence::Bytes(&ciphertext),
    ]))
}

/// SHA-256 of a complete wrap CBOR (the wrap hash the account state commits).
pub fn wrap_hash(wrap_cbor: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(wrap_cbor);
    hasher.update([]);
    hasher.finalize().into()
}

/// Derive the recovery wrap key from the 32-byte recovery material.
///
/// `wrap_key = KDF("pm-v1/recovery-wrap-key", recovery_material, [deployment, vault, generation, recovery_id])`
///
/// Used to seal the vault root key under the recovery material, so the vault
/// can be recovered with the recovery kit even if the master password is lost.
pub fn derive_recovery_wrap_key(
    recovery_material: &[u8; 32],
    deployment_id: &[u8; 16],
    vault_id: &[u8; 16],
    generation: u64,
    recovery_id: &[u8; 16],
) -> Result<AeadKey, KernelError> {
    let context = encode_evidence(&Evidence::Array(vec![
        Evidence::Bytes(deployment_id),
        Evidence::Bytes(vault_id),
        Evidence::Uint(generation),
        Evidence::Bytes(recovery_id),
    ]))?;
    let raw = crypto::kdf(b"pm-v1/recovery-wrap-key", recovery_material, &context)?;
    AeadKey::from_bytes(&raw)
}

/// Derive the recovery authentication seed from the recovery material.
///
/// `seed = KDF("pm-v1/recovery-auth-seed", recovery_material, [deployment, vault, generation, recovery_id])`
///
/// The seed produces an Ed25519 key pair for recovery co-authorization.
/// Recovery authority may obtain a bounded read session but never alone
/// authorizes operations 2-12 (ADR 0001).
pub fn derive_recovery_auth_seed(
    recovery_material: &[u8; 32],
    deployment_id: &[u8; 16],
    vault_id: &[u8; 16],
    generation: u64,
    recovery_id: &[u8; 16],
) -> Result<[u8; 32], KernelError> {
    let context = encode_evidence(&Evidence::Array(vec![
        Evidence::Bytes(deployment_id),
        Evidence::Bytes(vault_id),
        Evidence::Uint(generation),
        Evidence::Bytes(recovery_id),
    ]))?;
    crypto::kdf(b"pm-v1/recovery-auth-seed", recovery_material, &context)
}

/// Derive the bootstrap key from the bootstrap secret.
///
/// `key = KDF("pm-v1/bootstrap-key", bootstrap_secret, [deployment_id, server_identity_hash])`
///
/// The bootstrap key authenticates the initial vault bootstrap ceremony under
/// the MacEnvelope construction, before any device credentials exist.
pub fn derive_bootstrap_key(
    bootstrap_secret: &[u8; 32],
    deployment_id: &[u8; 16],
    server_identity_hash: &[u8; 32],
) -> Result<[u8; 32], KernelError> {
    let context = encode_evidence(&Evidence::Array(vec![
        Evidence::Bytes(deployment_id),
        Evidence::Bytes(server_identity_hash),
    ]))?;
    crypto::kdf(b"pm-v1/bootstrap-key", bootstrap_secret, &context)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    fn hex16(s: &str) -> [u8; 16] {
        let mut out = [0u8; 16];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    fn hex24(s: &str) -> [u8; 24] {
        let mut out = [0u8; 24];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    fn hexs(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Corpus (v1.json unlock-wrap-buckets) generation-1 known-answer vector.
    #[test]
    fn unlock_wrap_matches_corpus_generation_1() {
        let deployment = hex16("000102030405060708090a0b0c0d0e0f");
        let vault = hex16("101112131415161718191a1b1c1d1e1f");
        let salt = hex16("202122232425262728292a2b2c2d2e2f");
        let nonce = hex24("404142434445464748494a4b4c4d4e4f5051525354555657");
        let argon_output =
            hex32("735b81bb11a00f3ea8bf3b44d79b23b924d5ba084c21b6e8fe0ef64ac087cee9");
        let root = hex32("2222222222222222222222222222222222222222222222222222222222222222");

        let unlock_key = derive_unlock_key(&argon_output, &deployment, &vault, 1).unwrap();
        assert_eq!(
            hexs(unlock_key.as_bytes()),
            "a7a49ed54192d8ae097dd0d43d808029de5f9c7197aada33359984060d08fdd9",
            "unlock wrap key (corpus)"
        );

        let aad = UnlockWrapAad {
            deployment_id: &deployment,
            vault_id: &vault,
            generation: 1,
            salt: &salt,
            kib_memory: 65_536,
            iterations: 3,
            parallelism: 1,
            nonce: &nonce,
        };
        let wrap = seal_unlock_wrap(&unlock_key, &aad, &root).unwrap();
        assert_eq!(
            hexs(&wrap),
            concat!(
                "8b010150000102030405060708090a0b0c0d0e0f",
                "50101112131415161718191a1b1c1d1e1f01",
                "50202122232425262728292a2b2c2d2e2f",
                "1a0001000003015818404142434445464748494a4b4c4d4e4f5051525354555657",
                "5830a1416970856de06550f66bdc10a6e7d95300b76b383b535515f2deef38e9f05f6dab5097aefd92217985a052e423ba49",
            ),
            "unlock wrap CBOR (corpus)"
        );
        assert_eq!(
            hexs(&wrap_hash(&wrap)),
            "8df836677cb640a7355e03c997630c99d018002d8d7f107e51de1068f82855a0",
            "wrap hash (corpus)"
        );
    }

    #[test]
    fn wrong_password_derives_a_different_key() {
        let deployment = hex16("000102030405060708090a0b0c0d0e0f");
        let vault = hex16("101112131415161718191a1b1c1d1e1f");
        let key_a = derive_unlock_key(
            &hex32("735b81bb11a00f3ea8bf3b44d79b23b924d5ba084c21b6e8fe0ef64ac087cee9"),
            &deployment,
            &vault,
            1,
        )
        .unwrap();
        let mut wrong = hex32("735b81bb11a00f3ea8bf3b44d79b23b924d5ba084c21b6e8fe0ef64ac087cee9");
        wrong[0] ^= 0x01;
        let key_b = derive_unlock_key(&wrong, &deployment, &vault, 1).unwrap();
        assert_ne!(key_a.as_bytes(), key_b.as_bytes());
    }
}
