//! Recovery-kit encoding (ADR 0001).
//!
//! Recovery material is exactly 32 CSPRNG bytes. Its human form is RFC 4648
//! Base32 (lowercase, unpadded) of `entropy || checksum`, grouped into twelve
//! five-character groups separated by eleven hyphens (71 chars total), where
//! `checksum = SHA-256("pm-v1/recovery-checksum" || 0x00 || entropy)[0..5]`.
//!
//! Decode accepts exactly that 71-character lowercase form, removes only the
//! fixed-position hyphens, restores padding mechanically, rejects nonzero
//! unused bits, and verifies the checksum in constant time. It performs no
//! whitespace or case correction.

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::KernelError;

/// Recovery entropy length in bytes.
pub const RECOVERY_ENTROPY_BYTES: usize = 32;
const CHECKSUM_BYTES: usize = 5;
const BASE32_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

fn recovery_checksum(entropy: &[u8; RECOVERY_ENTROPY_BYTES]) -> [u8; CHECKSUM_BYTES] {
    let mut hasher = Sha256::new();
    hasher.update(b"pm-v1/recovery-checksum");
    hasher.update([0x00]);
    hasher.update(entropy);
    let digest = hasher.finalize();
    let mut checksum = [0u8; CHECKSUM_BYTES];
    checksum.copy_from_slice(&digest[..CHECKSUM_BYTES]);
    checksum
}

/// Encode 32 recovery bytes into the 71-character human form.
pub fn encode_recovery(entropy: &[u8; RECOVERY_ENTROPY_BYTES]) -> String {
    let checksum = recovery_checksum(entropy);
    let mut payload = [0u8; RECOVERY_ENTROPY_BYTES + CHECKSUM_BYTES];
    payload[..RECOVERY_ENTROPY_BYTES].copy_from_slice(entropy);
    payload[RECOVERY_ENTROPY_BYTES..].copy_from_slice(&checksum);
    let ungrouped = base32_encode(&payload);
    // 60 chars -> twelve groups of five, joined by hyphens.
    let mut out = String::with_capacity(71);
    for (index, chunk) in ungrouped.as_bytes().chunks(5).enumerate() {
        if index > 0 {
            out.push('-');
        }
        out.push_str(std::str::from_utf8(chunk).expect("base32 is ascii"));
    }
    out
}

/// Decode the 71-character human form back to the 32 recovery bytes.
pub fn decode_recovery(form: &str) -> Result<[u8; RECOVERY_ENTROPY_BYTES], KernelError> {
    if form.len() != 71 {
        return Err(KernelError::InvalidEncoding);
    }
    // Hyphens must be exactly at positions 5, 11, 17, ... (every 6th after a group).
    let bytes = form.as_bytes();
    let mut ungrouped = String::with_capacity(60);
    let mut group_index = 0;
    let mut within = 0;
    for &byte in bytes {
        if within == 5 {
            if byte != b'-' {
                return Err(KernelError::InvalidEncoding);
            }
            group_index += 1;
            within = 0;
            continue;
        }
        // Accept any RFC 4648 Base32 character (lowercase a-z or 2-7). Reject
        // uppercase, digits outside 2-7, whitespace, and any other byte.
        if base32_value(byte).is_some() {
            ungrouped.push(byte as char);
            within += 1;
        } else {
            return Err(KernelError::InvalidEncoding);
        }
    }
    if group_index != 11 || within != 5 {
        return Err(KernelError::InvalidEncoding);
    }
    let payload = base32_decode(&ungrouped)?;
    if payload.len() != RECOVERY_ENTROPY_BYTES + CHECKSUM_BYTES {
        return Err(KernelError::InvalidEncoding);
    }
    let mut entropy = [0u8; RECOVERY_ENTROPY_BYTES];
    entropy.copy_from_slice(&payload[..RECOVERY_ENTROPY_BYTES]);
    let expected_checksum = recovery_checksum(&entropy);
    // Constant-time comparison; reject any mismatch without short-circuit.
    if expected_checksum
        .ct_eq(&payload[RECOVERY_ENTROPY_BYTES..])
        .unwrap_u8()
        == 0
    {
        return Err(KernelError::InvalidEncoding);
    }
    Ok(entropy)
}

/// RFC 4648 Base32 encode (lowercase, unpadded).
fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u64 = 0;
    let mut bits: u32 = 0;
    for &byte in bytes {
        buffer = (buffer << 8) | u64::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 0x1f) as usize;
            out.push(BASE32_ALPHABET[index] as char);
        }
    }
    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 0x1f) as usize;
        out.push(BASE32_ALPHABET[index] as char);
    }
    out
}

/// RFC 4648 Base32 decode (lowercase, no padding). Rejects nonzero unused bits
/// in the final group: 37 input bytes encode into 60 chars (300 bits) but only
/// 296 bits are used, so the 4 trailing bits must be zero.
fn base32_decode(text: &str) -> Result<Vec<u8>, KernelError> {
    let mut buffer: u64 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    for byte in text.bytes() {
        let value = base32_value(byte).ok_or(KernelError::InvalidEncoding)?;
        buffer = (buffer << 5) | u64::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    // Any leftover bits after the final whole byte must be zero (encoder
    // zero-pads; nonzero unused bits are a negative vector).
    if bits > 0 && (buffer & ((1u64 << bits) - 1)) != 0 {
        return Err(KernelError::InvalidEncoding);
    }
    Ok(out)
}

fn base32_value(byte: u8) -> Option<u32> {
    match byte {
        b'a'..=b'z' => Some((byte - b'a') as u32),
        b'2'..=b'7' => Some((byte - b'2') as u32 + 26),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entropy_vec() -> [u8; 32] {
        [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
            0x1c, 0x1d, 0x1e, 0x1f,
        ]
    }

    #[test]
    fn checksum_matches_adr_vector() {
        assert_eq!(
            hex::encode(&recovery_checksum(&entropy_vec())),
            "1a58b3b408"
        );
    }

    #[test]
    fn encode_matches_adr_human_form() {
        assert_eq!(
            encode_recovery(&entropy_vec()),
            "aaaqe-ayeau-daoca-jbifq-ydiob-4ibce-qtcqk-rmfyy-denbw-ha5dy-pruwf-twqea"
        );
    }

    #[test]
    fn decode_round_trips_the_adr_vector() {
        let human = "aaaqe-ayeau-daoca-jbifq-ydiob-4ibce-qtcqk-rmfyy-denbw-ha5dy-pruwf-twqea";
        assert_eq!(decode_recovery(human).unwrap(), entropy_vec());
    }

    #[test]
    fn round_trip_for_a_random_entropy() {
        let entropy = [
            0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22,
            0x11, 0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0,
            0xd0, 0xe0, 0xf0, 0x0f,
        ];
        let encoded = encode_recovery(&entropy);
        assert_eq!(encoded.len(), 71);
        assert_eq!(decode_recovery(&encoded).unwrap(), entropy);
    }

    #[test]
    fn decode_rejects_uppercase() {
        let upper = "AAAQE-AYEAU-DAOCA-JBIFQ-YDIOB-4IBCE-QTCQK-RMFYY-DENBW-HA5YD-PRUWF-TWEA";
        assert_eq!(
            decode_recovery(upper).err(),
            Some(KernelError::InvalidEncoding)
        );
    }

    #[test]
    fn decode_rejects_moved_or_omitted_hyphens() {
        // Missing a hyphen (wrong length / grouping).
        assert_eq!(
            decode_recovery("aaaqeayeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypruwftwqea").err(),
            Some(KernelError::InvalidEncoding)
        );
        // Extra hyphen in the wrong spot.
        assert_eq!(
            decode_recovery(
                "aaaqe--ayeau-daoca-jbifq-ydiob-4ibce-qtcqk-rmfyy-denbw-ha5dy-pruwf-twqea"
            )
            .err(),
            Some(KernelError::InvalidEncoding)
        );
    }

    #[test]
    fn decode_rejects_whitespace_and_wrong_length() {
        assert_eq!(
            decode_recovery(
                " aaaqe-ayeau-daoca-jbifq-ydiob-4ibce-qtcqk-rmfyy-denbw-ha5dy-pruwf-twqea"
            )
            .err(),
            Some(KernelError::InvalidEncoding)
        );
        assert_eq!(
            decode_recovery("aaaqe-ayeau").err(),
            Some(KernelError::InvalidEncoding)
        );
    }

    #[test]
    fn decode_rejects_a_single_changed_character() {
        let mut human =
            "aaaqe-ayeau-daoca-jbifq-ydiob-4ibce-qtcqk-rmfyy-denbw-ha5dy-pruwf-twqea".to_string();
        // Flip one data character (not the checksum); checksum verification fails.
        human.replace_range(0..5, "aaaqf");
        assert_eq!(
            decode_recovery(&human).err(),
            Some(KernelError::InvalidEncoding)
        );
    }

    // Minimal hex helper (avoids adding a hex crate dependency for one test).
    mod hex {
        pub fn encode(bytes: &[u8]) -> String {
            let mut s = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&format!("{b:02x}"));
            }
            s
        }
    }
}
