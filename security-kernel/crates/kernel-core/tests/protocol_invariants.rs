use kernel_core::{
    KernelError, OsRandomSource, RandomSource, contracts_generated, derive_password_key,
};

#[test]
fn generated_domain_matches_reviewed_vector() {
    assert_eq!(
        contracts_generated::RECORD_ENVELOPE_DOMAIN,
        b"pm-v1/record-envelope"
    );
    assert_eq!(contracts_generated::PROTOCOL_VERSION, 1);
    assert_eq!(contracts_generated::SUITE_ID, 1);
    assert_eq!(
        contracts_generated::RECORD_PLAINTEXT_BUCKET_MAX_BYTES,
        16_777_216
    );
    assert_eq!(contracts_generated::RECORD_CIPHERTEXT_MAX_BYTES, 16_777_232);
    assert_eq!(contracts_generated::BACKUP_CHUNK_BYTES, 4_194_304);
}

#[test]
fn operating_system_random_source_fills_the_requested_buffer() {
    let mut output = [0_u8; 32];
    OsRandomSource.fill_bytes(&mut output).unwrap();

    assert!(output.iter().any(|byte| *byte != 0));
}

#[test]
fn portable_argon2id_profile_matches_independent_openssl_vector() {
    let derived = derive_password_key(
        b"INERT-PASSWORD",
        &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    )
    .unwrap();
    assert_eq!(
        derived.as_ref(),
        &[
            0x5f, 0x48, 0xc5, 0xaa, 0xbc, 0x95, 0x80, 0xd8, 0x13, 0x74, 0x9c, 0x07, 0x69, 0xb3,
            0x90, 0x80, 0x01, 0x1f, 0x6b, 0x2e, 0x45, 0xa5, 0x50, 0x8f, 0x9e, 0xae, 0x23, 0x8b,
            0xe0, 0xf0, 0xc6, 0x09,
        ]
    );
}

#[test]
fn errors_expose_only_stable_redacted_codes() {
    let error = KernelError::invalid_encoding();

    assert_eq!(error.stable_code(), "PM-KERNEL-INVALID-ENCODING");
    assert_eq!(error.to_string(), "PM-KERNEL-INVALID-ENCODING");
    assert!(!format!("{error:?}").contains("input"));
}
