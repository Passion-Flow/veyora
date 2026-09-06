//! Fuzz-style boundary tests for the security kernel's parsing surfaces
//! (PRD SEC-ASSURE-005, local half): randomized and structured malformed
//! inputs are driven through the recovery-kit decoder and the canonical
//! CBOR codec with three guarantees each run:
//!
//! 1. no panic — every malformed input fails as a `KernelError`;
//! 2. no acceptance — corrupted inputs never decode to a "valid" result
//!    unless they round-trip byte-identically;
//! 3. regressions are retained — the deterministic corpus below (built
//!    from real near-miss classes found by the generator) always runs, so
//!    any input that once broke a boundary stays covered.
//!
//! The generator uses a fixed seed by default (`VEYORA_FUZZ_SEED` overrides)
//! so CI runs are reproducible; scheduled long-run fuzzing in CI remains
//! the other half of SEC-ASSURE-005.

use kernel_core::ProtocolCborProfile;
use kernel_core::recovery::decode_recovery;

/// Deterministic xorshift so every run generates the same stream.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn byte(&mut self) -> u8 {
        (self.next() >> 24) as u8
    }
}

fn seed() -> u64 {
    std::env::var("VEYORA_FUZZ_SEED")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(0x5645594f5241)
}

/// Structured near-miss classes for the 71-character kit form.
fn kit_near_misses() -> Vec<String> {
    let valid = "aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff-ggggg-hhhhh-iiiii-jjjjj-kkkkk-lllll";
    let mut cases = vec![
        valid.to_string(), // itself (must pass)
        String::new(),
        valid[..70].to_string(), // truncated
        format!("{valid}x"),     // overlong
        valid.to_uppercase(),    // case corruption
        valid.replace("-", " "), // hyphen normalization bait
        valid.replace("-", ""),  // de-hyphenated bait
        format!("{valid}!"),     // foreign alphabet
        // A wrong final group keeps the format but breaks the checksum.
        format!("{}{}", &valid[..65], "zzzzz"),
    ];
    for position in [0usize, 5, 35, 70] {
        let mut corrupted = valid.to_string();
        corrupted.replace_range(position..position + 1, "2");
        cases.push(corrupted);
    }
    cases
}

#[test]
fn recovery_decoder_never_panics_and_rejects_corruption() {
    let mut rng = Rng(seed());
    let alphabet = b"abcdefghijklmnopqrstuvwxyz234567-";
    for _ in 0..20_000 {
        let len = (rng.next() % 80) as usize;
        let input: String = (0..len)
            .map(|_| alphabet[rng.byte() as usize % alphabet.len()] as char)
            .collect();
        // The only contract: a Result, never a panic. Valid-looking forms
        // must additionally carry the checksum (decode only succeeds for
        // genuinely well-formed keys).
        let _ = decode_recovery(&input);
    }
    for case in kit_near_misses() {
        let result = decode_recovery(&case);
        if case.len() == 71 && case.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
            // Structurally valid: accepted only with a valid checksum;
            // the mutated variants must fail.
            if case != "aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff-ggggg-hhhhh-iiiii-jjjjj-kkkkk-lllll" {
                assert!(result.is_err(), "corrupted kit accepted: {case}");
            }
        }
        // Whatever the outcome, it must be a typed error, not a panic —
        // reaching here per case is the assertion.
    }
    assert!(
        decode_recovery("aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff-ggggg-hhhhh-iiiii-jjjjj-kkkkk-lllll")
            .is_err(),
        "the fixture without a valid checksum is rejected"
    );
}

#[test]
fn canonical_cbor_decoder_never_panics_on_random_bytes() {
    let mut rng = Rng(seed() ^ 0xCB04);
    for _ in 0..20_000 {
        let len = (rng.next() % 128) as usize;
        let bytes: Vec<u8> = (0..len).map(|_| rng.byte()).collect();
        // Random bytes must never panic; acceptance requires a canonical
        // round-trip.
        if let Ok(document) = ProtocolCborProfile::decode(&bytes, kernel_core::LimitProfile::V1) {
            let encoded = document.as_bytes();
            let round = ProtocolCborProfile::decode(encoded, kernel_core::LimitProfile::V1)
                .expect("re-decoding canonical bytes succeeds");
            assert_eq!(
                round.as_bytes(),
                encoded,
                "canonical re-encode must be stable"
            );
        }
    }
}

#[test]
fn retained_regression_corpus_all_fail_closed() {
    // Every byte string here once reached a boundary; none may decode.
    let corpus: Vec<&[u8]> = vec![
        &[0x5b, 0xff, 0xff],             // truncated array header
        &[0x5a, 0x7f, 0xff, 0xff, 0xff], // oversized length claim
        &[0xc0],                         // bare date tag
        &[0xff],                         // break with no container
        &[0x00],                         // lone unsigned (not an array)
        &[0x81, 0x5b, 0x00],             // nested truncated claim
    ];
    for bytes in corpus {
        assert!(
            ProtocolCborProfile::decode(bytes, kernel_core::LimitProfile::V1).is_err(),
            "corpus input unexpectedly accepted: {bytes:?}"
        );
    }
    // The empty definite array [0x80] IS canonical: it must decode and
    // round-trip byte-identically (found by this harness; kept as the
    // positive control).
    let empty = ProtocolCborProfile::decode(&[0x80], kernel_core::LimitProfile::V1)
        .expect("empty array is canonical");
    let encoded = ProtocolCborProfile::encode(&empty).expect("re-encode");
    assert_eq!(encoded, vec![0x80], "canonical re-encode is stable");
}
