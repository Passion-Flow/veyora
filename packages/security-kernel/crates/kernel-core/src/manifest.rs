//! V1 chunked-Merkle synchronization manifest (ADR 0002).
//!
//! Leaves are sorted by raw 16-byte `record_id`. A leaf hash is
//! `SHA-256("pm-v1/manifest-leaf" || 0x00 || CBOR([record_id, revision, key_epoch,
//! envelope_hash, tombstone]))`. Adjacent leaves (up to page-size) form a chunk;
//! chunk and tree reduction use the ADR's exact domains with odd-node promotion.

use sha2::{Digest, Sha256};

use crate::KernelError;

const DOMAIN_EMPTY: &[u8] = b"pm-v1/manifest-empty\x00";
const DOMAIN_LEAF: &[u8] = b"pm-v1/manifest-leaf\x00";
const DOMAIN_CHUNK: &[u8] = b"pm-v1/manifest-chunk\x00";
const DOMAIN_NODE: &[u8] = b"pm-v1/manifest-node\x00";

/// Fixture-only domains mirrored from the manifest oracle so the corpus
/// known-answer roots can be reproduced. Product code generates record IDs and
/// envelope hashes from real authorization state, not from these fixtures.
const DOMAIN_RECORD_ID: &[u8] = b"pm-v1/manifest-fixture/record-id\x00";
const DOMAIN_ENVELOPE: &[u8] = b"pm-v1/manifest-fixture/envelope\x00";
const DOMAIN_RELATIONSHIP_SET: &[u8] = b"pm-v1/manifest-fixture/relationship-set\x00";

/// Closed canonical evidence subset (bool, u64, byte string, array) matching the
/// manifest oracle's deterministic encoder exactly. Used only for manifest-tree
/// hashing; record/envelope bodies use the protocol CBOR profile elsewhere.
#[derive(Clone, Debug)]
pub enum Evidence<'a> {
    Bool(bool),
    Uint(u64),
    Bytes(&'a [u8]),
    Array(Vec<Evidence<'a>>),
}

/// Encode evidence with the oracle's exact canonical rules: shortest-form
/// integers, major-type-2 byte strings, major-type-4 definite arrays, and the
/// simple values false (0xf4) / true (0xf5).
pub fn encode_evidence(value: &Evidence<'_>) -> Result<Vec<u8>, KernelError> {
    let mut out = Vec::new();
    encode_into(value, &mut out)?;
    Ok(out)
}

fn encode_into(value: &Evidence<'_>, out: &mut Vec<u8>) -> Result<(), KernelError> {
    match value {
        Evidence::Bool(false) => out.push(0xf4),
        Evidence::Bool(true) => out.push(0xf5),
        Evidence::Uint(n) => write_head(out, 0, *n)?,
        Evidence::Bytes(bytes) => {
            write_head(
                out,
                2,
                u64::try_from(bytes.len()).map_err(|_| KernelError::LimitExceeded)?,
            )?;
            out.try_reserve_exact(bytes.len())
                .map_err(|_| KernelError::LimitExceeded)?;
            out.extend_from_slice(bytes);
        }
        Evidence::Array(items) => {
            write_head(
                out,
                4,
                u64::try_from(items.len()).map_err(|_| KernelError::LimitExceeded)?,
            )?;
            for item in items {
                encode_into(item, out)?;
            }
        }
    }
    Ok(())
}

fn write_head(out: &mut Vec<u8>, major: u8, value: u64) -> Result<(), KernelError> {
    const LIMIT: u64 = u32::MAX as u64; // protocol u64 ceiling for evidence
    if value > LIMIT {
        return Err(KernelError::LimitExceeded);
    }
    let prefix = major << 5;
    if value < 24 {
        out.push(prefix | (value as u8));
    } else if value <= 0xFF {
        out.extend_from_slice(&[prefix | 24, value as u8]);
    } else if value <= 0xFFFF {
        out.push(prefix | 25);
        out.extend_from_slice(&(value as u16).to_be_bytes());
    } else {
        out.push(prefix | 26);
        out.extend_from_slice(&(value as u32).to_be_bytes());
    }
    Ok(())
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// The root of an empty vault: `SHA-256("pm-v1/manifest-empty" || 0x00)`.
#[must_use]
pub fn empty_root() -> [u8; 32] {
    sha256(&[DOMAIN_EMPTY])
}

/// A leaf hash for the given record metadata.
#[must_use]
pub fn leaf_hash(
    record_id: &[u8; 16],
    revision: u64,
    key_epoch: u64,
    envelope_hash: &[u8; 32],
    tombstone: bool,
) -> [u8; 32] {
    let body = encode_evidence(&Evidence::Array(vec![
        Evidence::Bytes(record_id),
        Evidence::Uint(revision),
        Evidence::Uint(key_epoch),
        Evidence::Bytes(envelope_hash),
        Evidence::Bool(tombstone),
    ]))
    .expect("leaf evidence encodes within limits");
    sha256(&[DOMAIN_LEAF, &body])
}

/// A single record leaf in a fixture vault (no relationships), reproducing the
/// oracle's deterministic record-id and envelope-hash derivation from a seed.
#[doc(hidden)]
#[must_use]
pub fn fixture_leaf(seed: &[u8; 32], ordinal: u64, tombstone: bool) -> ([u8; 16], [u8; 32]) {
    let ordinal_bytes = ordinal.to_be_bytes();
    let record_id_full = sha256(&[DOMAIN_RECORD_ID, seed, &ordinal_bytes]);
    let mut record_id = [0_u8; 16];
    record_id.copy_from_slice(&record_id_full[..16]);
    let relationship_commitment = sha256(&[DOMAIN_RELATIONSHIP_SET]);
    let envelope_hash = sha256(&[
        DOMAIN_ENVELOPE,
        seed,
        &ordinal_bytes,
        &0u64.to_be_bytes(),
        &0u64.to_be_bytes(),
        &relationship_commitment,
    ]);
    let hash = leaf_hash(&record_id, ordinal + 1, 1, &envelope_hash, tombstone);
    (record_id, hash)
}

/// Compute the manifest `current_root` for an ordered set of leaves.
///
/// `leaves` must already be sorted by raw `record_id`. They are chunked by
/// `page_size`, each chunk hashed with its index and id range, then the chunk
/// hashes are reduced pairwise with odd-node promotion to a single root.
pub fn root_from_leaves(
    leaves: &[([u8; 16], [u8; 32])],
    page_size: usize,
) -> Result<[u8; 32], KernelError> {
    if page_size == 0 {
        return Err(KernelError::LimitExceeded);
    }
    if leaves.is_empty() {
        return Ok(empty_root());
    }
    let mut chunk_hashes: Vec<[u8; 32]> = Vec::new();
    let mut start = 0usize;
    let mut chunk_index = 0u64;
    while start < leaves.len() {
        let end = (start + page_size).min(leaves.len());
        let first_id = leaves[start].0;
        let last_id = leaves[end - 1].0;
        let leaf_hashes: Vec<Evidence<'_>> = leaves[start..end]
            .iter()
            .map(|(_, hash)| Evidence::Bytes(hash))
            .collect();
        let chunk_body = encode_evidence(&Evidence::Array(vec![
            Evidence::Uint(chunk_index),
            Evidence::Bytes(&first_id),
            Evidence::Bytes(&last_id),
            Evidence::Array(leaf_hashes),
        ]))?;
        chunk_hashes.push(sha256(&[DOMAIN_CHUNK, &chunk_body]));
        start = end;
        chunk_index += 1;
    }
    Ok(reduce(chunk_hashes))
}

fn reduce(mut level: Vec<[u8; 32]>) -> [u8; 32] {
    while level.len() > 1 {
        let mut next: Vec<[u8; 32]> = Vec::new();
        let mut index = 0;
        while index < level.len() {
            if index + 1 == level.len() {
                // Odd final node is promoted unchanged (no duplication).
                next.push(level[index]);
                index += 1;
            } else {
                next.push(sha256(&[DOMAIN_NODE, &level[index], &level[index + 1]]));
                index += 2;
            }
        }
        level = next;
    }
    level[0]
}

/// Derive the manifest signing seed from the vault root key.
///
/// `seed = KDF("pm-v1/manifest-signing-seed", root_key, [deployment_id, vault_id, epoch, manifest_key_id])`
///
/// The seed is interpreted as an Ed25519 seed to produce the manifest signing
/// key pair. The public key is account-state-server-visible; the seed exists
/// only in unlocked clients.
pub fn derive_manifest_signing_seed(
    root_key: &[u8; 32],
    deployment_id: &[u8; 16],
    vault_id: &[u8; 16],
    epoch: u64,
    manifest_key_id: &[u8; 16],
) -> Result<[u8; 32], KernelError> {
    let context = encode_evidence(&Evidence::Array(vec![
        Evidence::Bytes(deployment_id),
        Evidence::Bytes(vault_id),
        Evidence::Uint(epoch),
        Evidence::Bytes(manifest_key_id),
    ]))?;
    crate::crypto::kdf(b"pm-v1/manifest-signing-seed", root_key, &context)
}

/// Derive the manifest signing key pair from the vault root key.
pub fn derive_manifest_signing_key(
    root_key: &[u8; 32],
    deployment_id: &[u8; 16],
    vault_id: &[u8; 16],
    epoch: u64,
    manifest_key_id: &[u8; 16],
) -> Result<
    (
        crate::crypto::Ed25519SecretKey,
        crate::crypto::Ed25519PublicKey,
    ),
    KernelError,
> {
    let seed =
        derive_manifest_signing_seed(root_key, deployment_id, vault_id, epoch, manifest_key_id)?;
    let key = crate::crypto::Ed25519SecretKey::from_seed(&seed);
    let public = key.public();
    Ok((key, public))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex32(s: &str) -> [u8; 32] {
        let mut out = [0_u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    fn fixture(
        seed_hex: &str,
        count: u64,
        _page_size: usize,
        tombstone_bits: &[bool],
    ) -> Vec<([u8; 16], [u8; 32])> {
        let seed = hex32(seed_hex);
        let mut leaves: Vec<([u8; 16], [u8; 32])> = (0..count)
            .map(|ordinal| {
                let tombstone = tombstone_bits
                    .get(ordinal as usize)
                    .copied()
                    .unwrap_or(false);
                fixture_leaf(&seed, ordinal, tombstone)
            })
            .collect();
        leaves.sort_by(|a, b| a.0.cmp(&b.0));
        leaves
    }

    /// Corpus KAT: empty vault.
    #[test]
    fn empty_root_matches_corpus() {
        assert_eq!(
            hex32("e4115741b843d9acbf403baee350ad9d8268ae04b1dfdd88c6d55b5739b62b3a"),
            empty_root()
        );
        assert_eq!(root_from_leaves(&[], 500).unwrap(), empty_root());
    }

    #[test]
    fn one_leaf_root_matches_corpus() {
        let leaves = fixture(
            "b4abbc7e4adbbacd8b3d3ac852819398fb5b41a1a7e9483c364f5d12187498a9",
            1,
            500,
            &[],
        );
        assert_eq!(
            root_from_leaves(&leaves, 500).unwrap(),
            hex32("cd2c15ddcd4409bcda54078efc92b87231e5feb8017209f69af45d4e17987e36")
        );
    }

    #[test]
    fn two_leaf_root_matches_corpus() {
        let leaves = fixture(
            "5af3bbd1edd0fe0340a93fa14389c573f806fdf8913b6c19c2e0c33831790407",
            2,
            1,
            &[],
        );
        assert_eq!(
            root_from_leaves(&leaves, 1).unwrap(),
            hex32("9dd4b05bdf19998faff222d09cfade0b9f59520383ee10143cec9fc0069925cc")
        );
    }

    #[test]
    fn odd_promotion_root_matches_corpus() {
        // page_size 1, three leaves: the third leaf's chunk is promoted unchanged.
        let leaves = fixture(
            "8191e929059d05ad99a8a3f8dd13b8aa9cae5e3e763a90426d603e4bcd8a918f",
            3,
            1,
            &[],
        );
        assert_eq!(
            root_from_leaves(&leaves, 1).unwrap(),
            hex32("81503951f99cbe82c611c75dabd698a5f5b53f56936b49d151604c752703d023")
        );
    }

    #[test]
    fn chunk_boundary_root_matches_corpus() {
        // page_size 500, 501 records -> two chunks (500 + 1), exercises the boundary.
        let leaves = fixture(
            "74de650650c88f057527fabbcd2183f4c373dfad44b7dc5df783e617a653867b",
            501,
            500,
            &[],
        );
        assert_eq!(
            root_from_leaves(&leaves, 500).unwrap(),
            hex32("8eaac7ec2fd2a550f57315d9b6818a1e1d7fbdf6ab2840172a7354b8d0ed0203")
        );
    }

    #[test]
    fn tampering_a_leaf_changes_the_root() {
        let mut leaves = fixture(
            "b4abbc7e4adbbacd8b3d3ac852819398fb5b41a1a7e9483c364f5d12187498a9",
            4,
            2,
            &[],
        );
        let clean = root_from_leaves(&leaves, 2).unwrap();
        leaves[0].1[0] ^= 0x01;
        let tampered = root_from_leaves(&leaves, 2).unwrap();
        assert_ne!(clean, tampered);
    }

    #[test]
    fn root_is_independent_of_input_order_because_caller_sorts() {
        // Caller sorts by record_id; presenting pre-sorted leaves must match
        // the same set regardless of how the caller obtained them.
        let a = fixture(
            "5af3bbd1edd0fe0340a93fa14389c573f806fdf8913b6c19c2e0c33831790407",
            2,
            1,
            &[],
        );
        let mut reversed = a.clone();
        reversed.reverse();
        // Re-sort both to record_id order; roots match.
        let mut s = a;
        s.sort_by(|x, y| x.0.cmp(&y.0));
        reversed.sort_by(|x, y| x.0.cmp(&y.0));
        assert_eq!(
            root_from_leaves(&s, 1).unwrap(),
            root_from_leaves(&reversed, 1).unwrap()
        );
    }

    #[test]
    fn zero_page_size_is_rejected() {
        let leaves = fixture(
            "b4abbc7e4adbbacd8b3d3ac852819398fb5b41a1a7e9483c364f5d12187498a9",
            1,
            500,
            &[],
        );
        assert_eq!(
            root_from_leaves(&leaves, 0).err(),
            Some(KernelError::LimitExceeded)
        );
    }
}
