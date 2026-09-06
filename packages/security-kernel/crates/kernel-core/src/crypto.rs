//! V1 cryptographic product operations.
//!
//! Implements the exact ADR 0001 construction for the operations the backend
//! and clients need to seal and open vault records, derive domain-separated
//! subkeys, and bind bodies to a domain. The repository does not implement
//! primitives; this composes the pinned RustCrypto primitives into the approved
//! product-specific envelope.
//!
//! ```text
//! KDF(label, ikm, context) =
//!   HKDF-Expand(HKDF-Extract(salt = 32 zero bytes, IKM = ikm),
//!               info = ASCII(label) || 0x00 || deterministic_cbor(context),
//!               L = 32)
//! preimage(D, B) = ASCII(D) || 0x00 || deterministic_cbor(B)
//! record AEAD    = XChaCha20-Poly1305, 32-byte key, 24-byte nonce,
//!                  16-byte tag, output = ciphertext || tag
//! ```

use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305,
    aead::{Aead, Payload},
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use minicbor::Decoder;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use crate::{KernelError, LimitProfile};

/// Ed25519 signature length in bytes.
pub const ED25519_SIGNATURE_BYTES: usize = 64;
/// Ed25519 seed / secret-key length in bytes.
pub const ED25519_SECRET_BYTES: usize = 32;

/// HKDF-Extract salt fixed at 32 zero bytes by ADR 0001.
const KDF_SALT: [u8; 32] = [0_u8; 32];
/// XChaCha20-Poly1305 tag length in bytes.
pub const AEAD_TAG_BYTES: usize = 16;
/// XChaCha20-Poly1305 nonce length in bytes.
pub const AEAD_NONCE_BYTES: usize = 24;
/// AEAD key length in bytes.
pub const AEAD_KEY_BYTES: usize = 32;
/// HKDF output length for every V1 derived subkey.
pub const KDF_OUTPUT_BYTES: usize = 32;

const _: () = assert!(AEAD_NONCE_BYTES == 24, "XChaCha20 nonce width is 24");

/// A 32-byte AEAD key derived through the V1 KDF.
///
/// The key is zeroized on drop and never exposes its raw bytes except through a
/// short-lived borrowed reference for a sealing/opening call.
#[derive(Clone)]
pub struct AeadKey(Zeroizing<[u8; AEAD_KEY_BYTES]>);

impl core::fmt::Debug for AeadKey {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str("AeadKey(REDACTED)")
    }
}

impl AeadKey {
    /// Construct a key from exactly 32 bytes, clearing the source on the error path.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, KernelError> {
        let mut owned: Box<[u8]> = bytes.into();
        let result = (owned.len() == AEAD_KEY_BYTES)
            .then(|| {
                let mut key = [0_u8; AEAD_KEY_BYTES];
                key.copy_from_slice(&owned);
                Self(Zeroizing::new(key))
            })
            .ok_or(KernelError::CryptographicFailure);
        owned.zeroize();
        result
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8; AEAD_KEY_BYTES] {
        &self.0
    }
}

/// A 24-byte XChaCha20-Poly1305 nonce.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AeadNonce([u8; AEAD_NONCE_BYTES]);

impl AeadNonce {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; AEAD_NONCE_BYTES]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; AEAD_NONCE_BYTES] {
        &self.0
    }

    /// Draw a fresh 24-byte nonce from a [`crate::RandomSource`].
    pub fn generate(source: &mut dyn crate::RandomSource) -> Result<Self, KernelError> {
        let mut bytes = [0_u8; AEAD_NONCE_BYTES];
        source.fill_bytes(&mut bytes)?;
        Ok(Self(bytes))
    }
}

/// Domain-separated HKDF derivation bound to ADR 0001.
///
/// `label` is an exact lowercase ASCII domain; `ikm` is the input key material
/// (for example the Argon2id password hash); `context_cbor` is the already
/// canonical-CBOR-encoded context. Returns 32 bytes.
pub fn kdf(
    label: &[u8],
    ikm: &[u8],
    context_cbor: &[u8],
) -> Result<[u8; KDF_OUTPUT_BYTES], KernelError> {
    if label.is_empty() || label.contains(&0) {
        return Err(KernelError::CryptographicFailure);
    }
    let mut info = Vec::with_capacity(label.len() + 1 + context_cbor.len());
    info.extend_from_slice(label);
    info.push(0x00);
    info.extend_from_slice(context_cbor);
    let hkdf = Hkdf::<Sha256>::new(Some(&KDF_SALT), ikm);
    let mut output = [0_u8; KDF_OUTPUT_BYTES];
    hkdf.expand(&info, &mut output)
        .map_err(|_| KernelError::CryptographicFailure)?;
    Ok(output)
}

/// Compute `preimage(D, B) = ASCII(D) || 0x00 || B`.
///
/// `body_cbor` must already be the deterministic-CBOR body encoding; this
/// function performs no re-encoding because callers own the canonical map
/// between a typed value and its bytes.
pub fn domain_preimage(domain: &[u8], body_cbor: &[u8]) -> Result<Vec<u8>, KernelError> {
    if domain.is_empty() || domain.contains(&0) {
        return Err(KernelError::CryptographicFailure);
    }
    let mut preimage = Vec::with_capacity(domain.len() + 1 + body_cbor.len());
    preimage.extend_from_slice(domain);
    preimage.push(0x00);
    preimage.extend_from_slice(body_cbor);
    Ok(preimage)
}

/// Derive a record-wrapping [`AeadKey`] from a root key and a record-binding
/// context.
///
/// The context is the canonical CBOR encoding of the record's binding tuple
/// (for example `deployment_id`, `vault_id`). A change to any bound identifier
/// therefore produces a different key and fails to open the existing record.
pub fn derive_record_key(
    root_key: &[u8; 32],
    record_context_cbor: &[u8],
) -> Result<AeadKey, KernelError> {
    let raw = kdf(b"pm-v1/record-key", root_key, record_context_cbor)?;
    AeadKey::from_bytes(&raw)
}

/// Encrypt `plaintext` under `key`/`nonce`, binding `aad`.
///
/// The output is `ciphertext || tag`, matching the ADR's "AEAD output is
/// ciphertext followed by tag only" rule. `plaintext` must be non-empty and
/// within the configured secret-text ceiling.
pub fn seal_record(
    key: &AeadKey,
    nonce: &AeadNonce,
    aad: &[u8],
    plaintext: &[u8],
    limits: LimitProfile,
) -> Result<Vec<u8>, KernelError> {
    if plaintext.is_empty() || plaintext.len() > limits.max_secret_text_bytes() {
        return Err(KernelError::LimitExceeded);
    }
    let cipher = XChaCha20Poly1305::new(key.as_bytes().into());
    let nonce = chacha20poly1305::XNonce::try_from(nonce.as_bytes().as_slice())
        .map_err(|_| KernelError::CryptographicFailure)?;
    cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| KernelError::CryptographicFailure)
}

/// Decrypt and authenticate `ciphertext_and_tag` (ciphertext || tag).
///
/// Fails closed on truncation, tag mismatch, wrong key, wrong nonce, or AAD
/// substitution. The plaintext length is rechecked against the limit before it
/// is returned.
pub fn open_record(
    key: &AeadKey,
    nonce: &AeadNonce,
    aad: &[u8],
    ciphertext_and_tag: &[u8],
    limits: LimitProfile,
) -> Result<Zeroizing<Vec<u8>>, KernelError> {
    if ciphertext_and_tag.len() < AEAD_TAG_BYTES + 1 {
        return Err(KernelError::InvalidEncoding);
    }
    let cipher = XChaCha20Poly1305::new(key.as_bytes().into());
    let nonce = chacha20poly1305::XNonce::try_from(nonce.as_bytes().as_slice())
        .map_err(|_| KernelError::CryptographicFailure)?;
    let mut plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext_and_tag,
                aad,
            },
        )
        .map_err(|_| KernelError::CryptographicFailure)?;
    if plaintext.is_empty() || plaintext.len() > limits.max_secret_text_bytes() {
        plaintext.zeroize();
        return Err(KernelError::LimitExceeded);
    }
    Ok(Zeroizing::new(plaintext))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LimitProfile, OsRandomSource};

    struct FixedNonce([u8; AEAD_NONCE_BYTES]);

    impl FixedNonce {
        fn new() -> Self {
            // A deterministic nonce so the round-trip tests are reproducible; the
            // real product draws fresh nonces from OsRandomSource per record.
            Self([0x42; AEAD_NONCE_BYTES])
        }
    }

    fn root_key() -> [u8; 32] {
        let mut key = [0_u8; 32];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = (index as u8).wrapping_mul(7);
        }
        key
    }

    #[test]
    fn round_trip_record_envelope_opens_what_was_sealed() {
        let limits = LimitProfile::V1;
        let key = derive_record_key(&root_key(), b"\x40").unwrap();
        let nonce = AeadNonce::from_bytes(FixedNonce::new().0);
        let aad = b"pm-v1/record-aad";
        let plaintext = b"secret vault entry plaintext";
        let sealed = seal_record(&key, &nonce, aad, plaintext, limits).unwrap();
        assert_eq!(sealed.len(), plaintext.len() + AEAD_TAG_BYTES);
        let opened = open_record(&key, &nonce, aad, &sealed, limits).unwrap();
        assert_eq!(opened.as_slice(), plaintext);
    }

    #[test]
    fn seal_then_open_with_os_nonce_round_trips() {
        let limits = LimitProfile::V1;
        let mut rng = OsRandomSource;
        let key = derive_record_key(&root_key(), b"\x40").unwrap();
        let nonce = AeadNonce::generate(&mut rng).unwrap();
        let plaintext = b"another entry";
        let sealed = seal_record(&key, &nonce, b"", plaintext, limits).unwrap();
        let opened = open_record(&key, &nonce, b"", &sealed, limits).unwrap();
        assert_eq!(opened.as_slice(), plaintext);
    }

    #[test]
    fn wrong_key_fails_closed() {
        let limits = LimitProfile::V1;
        let key_a = derive_record_key(&root_key(), b"\x40").unwrap();
        let mut other_root = [0_u8; 32];
        other_root[0] = 1;
        let key_b = derive_record_key(&other_root, b"\x40").unwrap();
        let nonce = AeadNonce::from_bytes(FixedNonce::new().0);
        let sealed = seal_record(&key_a, &nonce, b"", b"plaintext", limits).unwrap();
        assert_eq!(
            open_record(&key_b, &nonce, b"", &sealed, limits).err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn wrong_context_fails_closed() {
        let key = derive_record_key(&root_key(), b"\x40").unwrap();
        let other = derive_record_key(&root_key(), b"\x41").unwrap();
        assert_ne!(key.as_bytes(), other.as_bytes());
    }

    #[test]
    fn tampered_ciphertext_fails_closed() {
        let limits = LimitProfile::V1;
        let key = derive_record_key(&root_key(), b"\x40").unwrap();
        let nonce = AeadNonce::from_bytes(FixedNonce::new().0);
        let mut sealed = seal_record(&key, &nonce, b"", b"detect tampering", limits).unwrap();
        sealed[0] ^= 0x01;
        assert_eq!(
            open_record(&key, &nonce, b"", &sealed, limits).err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn aad_substitution_fails_closed() {
        let limits = LimitProfile::V1;
        let key = derive_record_key(&root_key(), b"\x40").unwrap();
        let nonce = AeadNonce::from_bytes(FixedNonce::new().0);
        let sealed = seal_record(&key, &nonce, b"aad-one", b"plaintext", limits).unwrap();
        assert_eq!(
            open_record(&key, &nonce, b"aad-two", &sealed, limits).err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn truncated_ciphertext_fails_closed() {
        let limits = LimitProfile::V1;
        let key = derive_record_key(&root_key(), b"\x40").unwrap();
        let nonce = AeadNonce::from_bytes(FixedNonce::new().0);
        assert_eq!(
            open_record(&key, &nonce, b"", &[0_u8; AEAD_TAG_BYTES], limits).err(),
            Some(KernelError::InvalidEncoding)
        );
    }

    #[test]
    fn empty_and_oversized_plaintext_rejected() {
        let limits = LimitProfile::V1;
        let key = derive_record_key(&root_key(), b"\x40").unwrap();
        let nonce = AeadNonce::from_bytes(FixedNonce::new().0);
        assert_eq!(
            seal_record(&key, &nonce, b"", b"", limits).err(),
            Some(KernelError::LimitExceeded)
        );
        let oversized = vec![b'a'; limits.max_secret_text_bytes() + 1];
        assert_eq!(
            seal_record(&key, &nonce, b"", &oversized, limits).err(),
            Some(KernelError::LimitExceeded)
        );
    }

    #[test]
    fn kdf_is_deterministic_and_domain_separated() {
        let a = kdf(b"pm-v1/record-key", &root_key(), b"\x40").unwrap();
        let b = kdf(b"pm-v1/record-key", &root_key(), b"\x40").unwrap();
        let c = kdf(b"pm-v1/other-key", &root_key(), b"\x40").unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn aead_key_rejects_wrong_length() {
        assert_eq!(
            AeadKey::from_bytes(&[0_u8; 16]).err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn kdf_rejects_label_containing_nul() {
        assert_eq!(
            kdf(b"label\x00suffix", &root_key(), b"").err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn domain_preimage_layout_is_exact() {
        let preimage = domain_preimage(b"pm-v1/test", b"\x40").unwrap();
        assert_eq!(preimage, b"pm-v1/test\x00\x40");
    }
}

// ─── Ed25519 signed envelope ──────────────────────────────────────────────
//
// SignedEnvelope(D, B, sk) = deterministic_cbor([B, Ed25519.Sign(sk, preimage(D, B))])
// preimage(D, B)           = ASCII(D) || 0x00 || B
//
// Verification decodes exactly one two-element array of two byte strings,
// re-encodes both items canonically, requires byte equality with the input
// (rejecting every non-canonical encoding), then verifies the signature over
// the domain preimage with strict Ed25519 rules.

/// An Ed25519 signing key (seed-derived). Zeroized on drop.
#[derive(Clone)]
pub struct Ed25519SecretKey(SigningKey);

impl core::fmt::Debug for Ed25519SecretKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Ed25519SecretKey(REDACTED)")
    }
}

impl Ed25519SecretKey {
    /// Construct from a 32-byte seed.
    pub fn from_seed(seed: &[u8; ED25519_SECRET_BYTES]) -> Self {
        Self(SigningKey::from_bytes(seed))
    }

    /// Draw a fresh key from a [`crate::RandomSource`].
    pub fn generate(source: &mut dyn crate::RandomSource) -> Result<Self, KernelError> {
        let mut seed = [0_u8; ED25519_SECRET_BYTES];
        source.fill_bytes(&mut seed)?;
        Ok(Self::from_seed(&seed))
    }

    /// The corresponding verifying (public) key.
    #[must_use]
    pub fn public(&self) -> Ed25519PublicKey {
        Ed25519PublicKey(self.0.verifying_key())
    }

    /// Produce `SignedEnvelope(D, B, sk)`. `body_cbor` must already be the
    /// canonical encoding of the body; it is bound into the envelope verbatim.
    pub fn sign_envelope(&self, domain: &[u8], body_cbor: &[u8]) -> Result<Vec<u8>, KernelError> {
        let preimage = domain_preimage(domain, body_cbor)?;
        let signature = self.0.sign(&preimage).to_bytes();
        encode_envelope(body_cbor, &signature)
    }
}

/// An Ed25519 verifying (public) key.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Ed25519PublicKey(VerifyingKey);

impl Ed25519PublicKey {
    /// Construct from 32 raw verifying-key bytes.
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<Self, KernelError> {
        VerifyingKey::from_bytes(bytes)
            .map(Self)
            .map_err(|_| KernelError::InvalidEncoding)
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 32] {
        self.0.as_bytes()
    }

    /// Verify a `SignedEnvelope`. On success returns the authenticated body
    /// bytes. Fails closed on any non-canonical encoding, truncation, trailing
    /// data, signature mismatch, or domain substitution.
    pub fn verify_envelope(&self, domain: &[u8], envelope: &[u8]) -> Result<Vec<u8>, KernelError> {
        let (body, signature) = decode_canonical_envelope(envelope)?;
        let preimage = domain_preimage(domain, &body)?;
        let signature =
            Signature::from_slice(&signature).map_err(|_| KernelError::InvalidEncoding)?;
        self.0
            .verify(&preimage, &signature)
            .map_err(|_| KernelError::CryptographicFailure)?;
        Ok(body)
    }
}

// ─── HMAC-SHA-256 (for MacEnvelope) ────────────────────────────────────────

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut block_key = [0u8; 64];
    if key.len() > 64 {
        let mut h = Sha256::new();
        h.update(key);
        let digest = h.finalize();
        block_key[..32].copy_from_slice(&digest);
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0u8; 64];
    let mut opad = [0u8; 64];
    for i in 0..64 {
        ipad[i] = block_key[i] ^ 0x36;
        opad[i] = block_key[i] ^ 0x5c;
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    outer.finalize().into()
}

/// HMAC tag length for MacEnvelope.
pub const MAC_TAG_BYTES: usize = 32;

/// Compute `MacEnvelope(D, B, key) = 0x82 || B || bstr(32, HMAC-SHA-256(key, preimage(D, B)))`.
/// Used only for initial bootstrap under the derived bootstrap key. It is never
/// accepted where an Ed25519 SignedEnvelope or WebAuthn authorization is required.
pub fn mac_envelope(domain: &[u8], body_cbor: &[u8], key: &[u8]) -> Result<Vec<u8>, KernelError> {
    let preimage = domain_preimage(domain, body_cbor)?;
    let tag = hmac_sha256(key, &preimage);
    let mut out = Vec::with_capacity(1 + body_cbor.len() + 2 + MAC_TAG_BYTES);
    out.push(0x82);
    out.extend_from_slice(body_cbor);
    out.push(0x58);
    out.push(0x20); // bstr(32)
    out.extend_from_slice(&tag);
    Ok(out)
}

/// Verify a MacEnvelope. Returns the authenticated body bytes on success.
/// Fails closed on any non-canonical encoding, truncation, or tag mismatch
/// (constant-time comparison).
pub fn verify_mac_envelope(
    domain: &[u8],
    envelope: &[u8],
    key: &[u8],
) -> Result<Vec<u8>, KernelError> {
    let mut decoder = Decoder::new(envelope);
    if decoder
        .array()
        .map_err(|_| KernelError::NonCanonicalEncoding)?
        != Some(2)
    {
        return Err(KernelError::NonCanonicalEncoding);
    }
    let body_start = decoder.position();
    decoder
        .skip()
        .map_err(|_| KernelError::NonCanonicalEncoding)?;
    let body_end = decoder.position();
    let body = envelope[body_start..body_end].to_vec();
    let tag_bytes = decoder
        .bytes()
        .map_err(|_| KernelError::NonCanonicalEncoding)?;
    if tag_bytes.len() != MAC_TAG_BYTES {
        return Err(KernelError::InvalidEncoding);
    }
    if decoder.position() != envelope.len() {
        return Err(KernelError::NonCanonicalEncoding);
    }
    let preimage = domain_preimage(domain, &body)?;
    let expected_tag = hmac_sha256(key, &preimage);
    if expected_tag.ct_eq(tag_bytes).unwrap_u8() == 0 {
        return Err(KernelError::CryptographicFailure);
    }
    Ok(body)
}

fn encode_envelope(body_cbor: &[u8], signature: &[u8]) -> Result<Vec<u8>, KernelError> {
    let mut out = Vec::with_capacity(1 + body_cbor.len() + 2 + signature.len());
    out.push(0x82); // array(2)
    out.extend_from_slice(body_cbor); // body as a raw CBOR item, inlined
    // signature as a definite byte string of 64 bytes: 0x58 0x40
    out.push(0x58);
    out.push(0x40);
    out.extend_from_slice(signature);
    Ok(out)
}

/// Decode and authenticate the canonical form of a two-element array envelope.
/// The first element is a raw CBOR item (the body), the second is a 64-byte
/// byte string (the Ed25519 signature). Rejects indefinite arrays, non-two
/// lengths, wrong signature length, trailing bytes, and non-canonical encoding.
fn decode_canonical_envelope(
    envelope: &[u8],
) -> Result<(Vec<u8>, [u8; ED25519_SIGNATURE_BYTES]), KernelError> {
    let mut decoder = Decoder::new(envelope);
    if decoder
        .array()
        .map_err(|_| KernelError::NonCanonicalEncoding)?
        != Some(2)
    {
        return Err(KernelError::NonCanonicalEncoding);
    }
    let body_start = decoder.position();
    decoder
        .skip()
        .map_err(|_| KernelError::NonCanonicalEncoding)?;
    let body_end = decoder.position();
    let body = envelope[body_start..body_end].to_vec();
    let signature_bytes = decoder
        .bytes()
        .map_err(|_| KernelError::NonCanonicalEncoding)?;
    if signature_bytes.len() != ED25519_SIGNATURE_BYTES {
        return Err(KernelError::InvalidEncoding);
    }
    let mut signature = [0_u8; ED25519_SIGNATURE_BYTES];
    signature.copy_from_slice(signature_bytes);
    if decoder.position() != envelope.len() {
        return Err(KernelError::NonCanonicalEncoding);
    }
    let canonical = encode_envelope(&body, &signature)?;
    if canonical != envelope {
        return Err(KernelError::NonCanonicalEncoding);
    }
    Ok((body, signature))
}

#[cfg(test)]
mod envelope_tests {
    use super::*;

    /// RFC 8032 §7.1 layered known-answer: sign/verify under a published seed.
    #[test]
    fn ed25519_signing_key_matches_published_public_key() {
        let seed_hex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
        let pub_hex = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
        let seed = hex(seed_hex);
        let key = Ed25519SecretKey::from_seed(&seed);
        assert_eq!(hex_array(key.public().as_bytes()), pub_hex);
    }

    #[test]
    fn envelope_round_trips_and_returns_body() {
        let mut rng = crate::OsRandomSource;
        let key = Ed25519SecretKey::generate(&mut rng).unwrap();
        let body = b"\x82\x40\x40"; // inert canonical body
        let envelope = key.sign_envelope(b"pm-v1/test", body).unwrap();
        let opened = key
            .public()
            .verify_envelope(b"pm-v1/test", &envelope)
            .unwrap();
        assert_eq!(opened, body);
    }

    #[test]
    fn envelope_rejects_domain_substitution() {
        let mut rng = crate::OsRandomSource;
        let key = Ed25519SecretKey::generate(&mut rng).unwrap();
        let envelope = key.sign_envelope(b"pm-v1/one", b"\x40").unwrap();
        assert_eq!(
            key.public().verify_envelope(b"pm-v1/two", &envelope).err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn envelope_rejects_wrong_key() {
        let mut rng = crate::OsRandomSource;
        let a = Ed25519SecretKey::generate(&mut rng).unwrap();
        let b = Ed25519SecretKey::generate(&mut rng).unwrap();
        let envelope = a.sign_envelope(b"pm-v1/test", b"\x40").unwrap();
        assert_eq!(
            b.public().verify_envelope(b"pm-v1/test", &envelope).err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn envelope_rejects_tampered_body_and_signature() {
        let mut rng = crate::OsRandomSource;
        let key = Ed25519SecretKey::generate(&mut rng).unwrap();
        let envelope = key
            .sign_envelope(b"pm-v1/test", b"\x83\x01\x02\x03")
            .unwrap();
        // A body-byte mutation changes the preimage and fails signature
        // verification (the body is a raw inlined CBOR item, so canonicality is
        // preserved but the signature no longer matches).
        let mut body_tampered = envelope.clone();
        // Flip an interior body byte (byte[2] = 0x02 → 0x03); CBOR stays valid
        // but the preimage changes so the signature no longer matches.
        body_tampered[2] ^= 0x01;
        assert_eq!(
            key.public()
                .verify_envelope(b"pm-v1/test", &body_tampered)
                .err(),
            Some(KernelError::CryptographicFailure)
        );
        // A signature-byte mutation also fails verification.
        let mut sig_tampered = envelope;
        let last = sig_tampered.len() - 1;
        sig_tampered[last] ^= 0x01;
        assert_eq!(
            key.public()
                .verify_envelope(b"pm-v1/test", &sig_tampered)
                .err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn envelope_rejects_non_canonical_and_truncated_inputs() {
        let mut rng = crate::OsRandomSource;
        let key = Ed25519SecretKey::generate(&mut rng).unwrap();
        // Truncated.
        assert!(key.public().verify_envelope(b"pm-v1/test", &[]).is_err());
        // Wrong outer type (a byte string, not an array).
        assert!(
            key.public()
                .verify_envelope(b"pm-v1/test", &[0x40])
                .is_err()
        );
        // Trailing data after a valid envelope.
        let mut with_trailer = key.sign_envelope(b"pm-v1/test", b"\x40").unwrap();
        with_trailer.push(0x00);
        assert_eq!(
            key.public()
                .verify_envelope(b"pm-v1/test", &with_trailer)
                .err(),
            Some(KernelError::NonCanonicalEncoding)
        );
    }

    fn hex(s: &str) -> [u8; 32] {
        let mut out = [0_u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    fn hex_array(bytes: &[u8; 32]) -> String {
        let mut s = String::with_capacity(64);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    /// Corpus (v1.json signed-checkpoint) known-answer vector.
    #[test]
    fn signed_checkpoint_envelope_matches_corpus_kat() {
        let seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
        let key = Ed25519SecretKey::from_seed(&seed);
        let body = hex_vec(
            "91010150000102030405060708090a0b0c0d0e0f50101112131415161718191a1b1c1d1e1f04\
             50202122232425262728292a2b2c2d2e2f0150303132333435363738393a3b3c3d3e3f07\
             5820404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f01\
             5820606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f02\
             0101001a6553f100",
        );
        let envelope = key
            .sign_envelope(b"pm-v1/trusted-checkpoint", &body)
            .unwrap();
        // The envelope = 0x82 || body || 0x5840 || 64-byte signature.
        let expected = hex_vec(
            "8291010150000102030405060708090a0b0c0d0e0f50101112131415161718191a1b1c1d1e1f04\
             50202122232425262728292a2b2c2d2e2f0150303132333435363738393a3b3c3d3e3f07\
             5820404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f01\
             5820606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f02\
             0101001a6553f10058409ddf776282aac7b2d60dd5083f8ca8de49790d2d9c88e2f757\
             c081428308148d71904611454e8a7d0bc92067f7c00406c72eaf9ca129f3b48167064\
             d527dd202",
        );
        assert_eq!(
            envelope, expected,
            "signed-checkpoint envelope must match corpus"
        );
        // Round-trip verification.
        let recovered = key
            .public()
            .verify_envelope(b"pm-v1/trusted-checkpoint", &envelope)
            .unwrap();
        assert_eq!(recovered, body);
    }

    fn hex_vec(s: &str) -> Vec<u8> {
        let clean: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        (0..clean.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&clean[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn mac_envelope_round_trips() {
        let key = [0x42u8; 32];
        let body = b"\x82\x40\x40";
        let env = super::mac_envelope(b"pm-v1/bootstrap", body, &key).unwrap();
        let recovered = super::verify_mac_envelope(b"pm-v1/bootstrap", &env, &key).unwrap();
        assert_eq!(recovered, body);
    }

    #[test]
    fn mac_envelope_rejects_wrong_key() {
        let key = [0x42u8; 32];
        let wrong = [0x43u8; 32];
        let body = b"\x40";
        let env = super::mac_envelope(b"pm-v1/bootstrap", body, &key).unwrap();
        assert_eq!(
            super::verify_mac_envelope(b"pm-v1/bootstrap", &env, &wrong).err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn mac_envelope_rejects_domain_substitution() {
        let key = [0x42u8; 32];
        let body = b"\x40";
        let env = super::mac_envelope(b"pm-v1/bootstrap", body, &key).unwrap();
        assert_eq!(
            super::verify_mac_envelope(b"pm-v1/wrong", &env, &key).err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn mac_envelope_rejects_tampered_body() {
        let key = [0x42u8; 32];
        let body = b"\x83\x01\x02\x03";
        let mut env = super::mac_envelope(b"pm-v1/bootstrap", body, &key).unwrap();
        env[2] ^= 0x01; // flip a body byte
        assert_eq!(
            super::verify_mac_envelope(b"pm-v1/bootstrap", &env, &key).err(),
            Some(KernelError::CryptographicFailure)
        );
    }

    #[test]
    fn mac_envelope_rejects_non_canonical_input() {
        let key = [0x42u8; 32];
        assert!(super::verify_mac_envelope(b"pm-v1/bootstrap", &[], &key).is_err());
        assert!(super::verify_mac_envelope(b"pm-v1/bootstrap", &[0x40], &key).is_err());
    }
}

#[cfg(test)]
mod client_json_tests {
    use sha2::Digest;
    /// Corpus (v1.json webauthn-client-json) KAT: SHA-256 of the client data JSON.
    #[test]
    fn client_data_json_hash_matches_corpus() {
        let json_hex = "7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a227457566e7a7337463068327464454b39583337333950674e6b394e305f764b31554b795a75337655326438222c226f726967696e223a2268747470733a2f2f7661756c742e6578616d706c652e696e76616c6964222c2263726f73734f726967696e223a66616c73657d";
        let json_bytes: Vec<u8> = (0..json_hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&json_hex[i..i + 2], 16).unwrap())
            .collect();
        let hash: [u8; 32] = sha2::Sha256::digest(&json_bytes).into();
        let actual: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            actual, "009a2ef2b9f0b1dc804d945f8efba928cf3cbc327f019b9110709a6ede782fa3",
            "client_data_sha256 must match corpus"
        );
    }
}
