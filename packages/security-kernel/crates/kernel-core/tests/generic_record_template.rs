use kernel_core::{
    LimitProfile, contracts_generated::GenericEncryptedRecordV1, validate_generic_record,
};

const TAG_BYTES: usize = 16;

fn inert_record(ciphertext_bytes: usize) -> GenericEncryptedRecordV1 {
    GenericEncryptedRecordV1 {
        protocol_version: 1,
        suite_id: 1,
        deployment_id: "000102030405060708090a0b0c0d0e0f".into(),
        vault_id: "101112131415161718191a1b1c1d1e1f".into(),
        record_id: "202122232425262728292a2b2c2d2e2f".into(),
        revision: 1,
        ciphertext: "x".repeat(ciphertext_bytes),
        ciphertext_hash: "30".repeat(32),
        ciphertext_length: ciphertext_bytes as u64,
        tombstone: false,
        template_envelope_hash: "40".repeat(32),
        manifest_binding: "50".repeat(32),
    }
}

#[test]
fn generic_record_validation_does_not_require_a_server_visible_category() {
    validate_generic_record(&inert_record(1_024 + TAG_BYTES), LimitProfile::V1).unwrap();
    validate_generic_record(&inert_record(2_048 + TAG_BYTES), LimitProfile::V1).unwrap();
}

#[test]
fn generic_record_accepts_the_generated_two_mib_bucket() {
    validate_generic_record(&inert_record(2_097_152 + TAG_BYTES), LimitProfile::V1).unwrap();
}

#[test]
fn generic_record_accepts_only_the_adr_bucket_schedule() {
    for bucket in [
        1_024, 2_048, 3_072, 4_096, 8_192, 65_536, 131_072, 1_048_576, 16_777_216,
    ] {
        validate_generic_record(&inert_record(bucket + TAG_BYTES), LimitProfile::V1).unwrap();
    }

    for bucket in [1_023, 1_025, 5_120, 69_632, 196_608] {
        assert!(
            validate_generic_record(&inert_record(bucket + TAG_BYTES), LimitProfile::V1).is_err(),
            "accepted unscheduled bucket {bucket}"
        );
    }
}

#[test]
fn generic_record_validation_rejects_unbounded_or_malformed_metadata() {
    let mut record = inert_record(1_024 + TAG_BYTES);
    record.record_id = "not-an-opaque-id".into();
    assert!(validate_generic_record(&record, LimitProfile::V1).is_err());

    let mut record = inert_record(1_024 + TAG_BYTES);
    record.revision = 0;
    assert!(validate_generic_record(&record, LimitProfile::V1).is_err());

    let record = inert_record(
        usize::try_from(kernel_core::contracts_generated::RECORD_CIPHERTEXT_MAX_BYTES).unwrap() + 1,
    );
    assert!(validate_generic_record(&record, LimitProfile::V1).is_err());

    let mut record = inert_record(1_024 + TAG_BYTES);
    record.ciphertext_length -= 1;
    assert!(validate_generic_record(&record, LimitProfile::V1).is_err());
}
