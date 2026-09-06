use kernel_core::{LimitProfile, ProtocolCborProfile, WebAuthnCborKind, WebAuthnCborProfile};

const P256_X: [u8; 32] = [
    0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc, 0xe6, 0xe5, 0x63, 0xa4, 0x40, 0xf2,
    0x77, 0x03, 0x7d, 0x81, 0x2d, 0xeb, 0x33, 0xa0, 0xf4, 0xa1, 0x39, 0x45, 0xd8, 0x98, 0xc2, 0x96,
];
const P256_Y: [u8; 32] = [
    0x4f, 0xe3, 0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7, 0xeb, 0x4a, 0x7c, 0x0f, 0x9e, 0x16,
    0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31, 0x5e, 0xce, 0xcb, 0xb6, 0x40, 0x68, 0x37, 0xbf, 0x51, 0xf5,
];

fn cose_key() -> Vec<u8> {
    let mut bytes = vec![0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20];
    bytes.extend_from_slice(&P256_X);
    bytes.extend_from_slice(&[0x22, 0x58, 0x20]);
    bytes.extend_from_slice(&P256_Y);
    bytes
}

fn attestation_object() -> Vec<u8> {
    let mut bytes = vec![
        0xa3, 0x63, b'f', b'm', b't', 0x64, b'n', b'o', b'n', b'e', 0x67, b'a', b't', b't', b'S',
        b't', b'm', b't', 0xa0, 0x68, b'a', b'u', b't', b'h', b'D', b'a', b't', b'a', 0x58, 0x25,
    ];
    bytes.extend_from_slice(&[0_u8; 37]);
    bytes
}

fn oversized_attestation_object() -> Vec<u8> {
    let mut bytes = vec![
        0xa3, 0x63, b'f', b'm', b't', 0x64, b'n', b'o', b'n', b'e', 0x67, b'a', b't', b't', b'S',
        b't', b'm', b't', 0xa0, 0x68, b'a', b'u', b't', b'h', b'D', b'a', b't', b'a', 0x59, 0x04,
        0x01,
    ];
    bytes.extend_from_slice(&[0_u8; 1_025]);
    bytes
}

#[test]
fn protocol_profile_accepts_only_canonical_array_tuples() {
    let canonical = [0x85, 0x01, 0x42, 0xaa, 0xbb, 0x81, 0x02, 0xf5, 0xf4];
    let decoded = ProtocolCborProfile::decode(&canonical, LimitProfile::V1).unwrap();

    assert_eq!(ProtocolCborProfile::encode(&decoded).unwrap(), canonical);

    for rejected in [
        vec![0x18, 0x01],       // top-level integer and non-shortest integer
        vec![0x81, 0x18, 0x01], // non-shortest nested integer
        vec![0x81, 0x1b, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // above 2^63-1
        vec![0x9f, 0x01, 0xff], // indefinite array
        vec![0x81, 0x5f, 0x41, 0, 0xff], // indefinite byte string
        vec![0xa0],             // map
        vec![0x81, 0x61, b'x'], // text
        vec![0x81, 0xc0, 0x00], // tag
        vec![0x81, 0xf9, 0x00, 0x00], // float
        vec![0x81, 0xf6],       // null
        vec![0x81, 0xf7],       // undefined
        vec![0x81, 0xe0],       // unassigned simple value
        vec![0x82, 0x01],       // truncated array
        vec![0x81, 0x01, 0x00], // trailing second item
    ] {
        assert!(
            ProtocolCborProfile::decode(&rejected, LimitProfile::V1).is_err(),
            "accepted {rejected:02x?}"
        );
    }
}

#[test]
fn webauthn_profile_accepts_only_closed_attestation_and_cose_maps() {
    let attestation = attestation_object();
    let decoded = WebAuthnCborProfile::decode(&attestation, LimitProfile::V1).unwrap();
    assert_eq!(decoded.kind(), WebAuthnCborKind::NoneAttestationObject);
    assert_eq!(WebAuthnCborProfile::encode(&decoded).unwrap(), attestation);

    let cose = cose_key();
    let decoded = WebAuthnCborProfile::decode(&cose, LimitProfile::V1).unwrap();
    assert_eq!(decoded.kind(), WebAuthnCborKind::Es256CoseKey);
    assert_eq!(WebAuthnCborProfile::encode(&decoded).unwrap(), cose);
}

#[test]
fn webauthn_profile_rejects_unknown_duplicate_reordered_and_noncanonical_maps() {
    let canonical = cose_key();

    let mut reordered = canonical.clone();
    reordered.splice(1..5, [0x03, 0x26, 0x01, 0x02]);

    let mut unknown = canonical.clone();
    unknown[0] = 0xa6;
    unknown.extend_from_slice(&[0x04, 0x00]);

    let mut duplicate = canonical.clone();
    duplicate[0] = 0xa6;
    duplicate.extend_from_slice(&[0x01, 0x02]);

    let mut invalid_point = canonical.clone();
    invalid_point[10..42].fill(0);
    invalid_point[45..77].fill(0);

    for rejected in [
        reordered,
        unknown,
        duplicate,
        invalid_point,
        oversized_attestation_object(),
        vec![0xbf, 0xff],
        vec![0x81, 0x01],
        [canonical.as_slice(), &[0x00]].concat(),
        vec![0xc0, 0xa0],
    ] {
        assert!(
            WebAuthnCborProfile::decode(&rejected, LimitProfile::V1).is_err(),
            "accepted {rejected:02x?}"
        );
    }
}

#[test]
fn profiles_cannot_accept_each_others_grammar() {
    assert!(ProtocolCborProfile::decode(&cose_key(), LimitProfile::V1).is_err());
    assert!(WebAuthnCborProfile::decode(&[0x81, 0x01], LimitProfile::V1).is_err());
}

#[test]
fn byte_and_item_limits_are_checked_before_owned_allocation() {
    let tiny = LimitProfile::new(32, 2, 8, 8, 1024).unwrap();
    assert!(ProtocolCborProfile::decode(&[0x83, 0x01, 0x02, 0x03], tiny).is_err());
    assert!(ProtocolCborProfile::decode(&[0x81, 0x49, 0, 0, 0, 0, 0, 0, 0, 0, 0], tiny).is_err());
}

#[test]
fn custom_limit_profiles_can_only_tighten_v1() {
    let v1 = LimitProfile::V1;
    for rejected in [
        LimitProfile::new(
            0,
            v1.max_collection_items(),
            v1.max_byte_string_bytes(),
            v1.max_nesting_depth(),
            v1.max_secret_text_bytes(),
        ),
        LimitProfile::new(
            v1.max_document_bytes(),
            0,
            v1.max_byte_string_bytes(),
            v1.max_nesting_depth(),
            v1.max_secret_text_bytes(),
        ),
        LimitProfile::new(
            v1.max_document_bytes(),
            v1.max_collection_items(),
            0,
            v1.max_nesting_depth(),
            v1.max_secret_text_bytes(),
        ),
        LimitProfile::new(
            v1.max_document_bytes(),
            v1.max_collection_items(),
            v1.max_byte_string_bytes(),
            0,
            v1.max_secret_text_bytes(),
        ),
        LimitProfile::new(
            v1.max_document_bytes(),
            v1.max_collection_items(),
            v1.max_byte_string_bytes(),
            v1.max_nesting_depth(),
            0,
        ),
    ] {
        assert!(rejected.is_err());
    }
    for rejected in [
        LimitProfile::new(
            v1.max_document_bytes() + 1,
            v1.max_collection_items(),
            v1.max_byte_string_bytes(),
            v1.max_nesting_depth(),
            v1.max_secret_text_bytes(),
        ),
        LimitProfile::new(
            v1.max_document_bytes(),
            v1.max_collection_items() + 1,
            v1.max_byte_string_bytes(),
            v1.max_nesting_depth(),
            v1.max_secret_text_bytes(),
        ),
        LimitProfile::new(
            v1.max_document_bytes(),
            v1.max_collection_items(),
            v1.max_byte_string_bytes() + 1,
            v1.max_nesting_depth(),
            v1.max_secret_text_bytes(),
        ),
        LimitProfile::new(
            v1.max_document_bytes(),
            v1.max_collection_items(),
            v1.max_byte_string_bytes(),
            v1.max_nesting_depth() + 1,
            v1.max_secret_text_bytes(),
        ),
        LimitProfile::new(
            v1.max_document_bytes(),
            v1.max_collection_items(),
            v1.max_byte_string_bytes(),
            v1.max_nesting_depth(),
            v1.max_secret_text_bytes() + 1,
        ),
    ] {
        assert!(rejected.is_err());
    }
}

#[test]
fn hostile_declared_lengths_return_errors_without_panicking() {
    let hostile = [
        vec![0x99, 0x0f, 0xff],                   // 4,095 children, no child bytes
        vec![0x9a, 0xff, 0xff, 0xff, 0xff],       // child count over item budget
        vec![0x81, 0x5a, 0xff, 0xff, 0xff, 0xff], // oversized truncated byte string
    ];

    for bytes in hostile {
        let result =
            std::panic::catch_unwind(|| ProtocolCborProfile::decode(&bytes, LimitProfile::V1));
        assert!(result.is_ok(), "decoder panicked for {bytes:02x?}");
        assert!(result.unwrap().is_err(), "decoder accepted {bytes:02x?}");
    }
}

#[test]
fn protocol_cbor_matches_corpus_kat() {
    let corpus: Vec<u8> = (0..)
        .step_by(2)
        .take(57)
        .map(|i| {
            let hex = "8601f4f550000102030405060708090a0b0c0d0e0f18185820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
            u8::from_str_radix(&hex[i..i + 2], 16).unwrap()
        })
        .collect();
    let decoded = ProtocolCborProfile::decode(&corpus, LimitProfile::V1).unwrap();
    let reencoded = ProtocolCborProfile::encode(&decoded).unwrap();
    assert_eq!(
        reencoded, corpus,
        "round-trip must preserve exact corpus bytes"
    );
    use sha2::Digest;
    let hash: String = sha2::Sha256::digest(&corpus)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        hash,
        "388596f15a4ded74dbb9fd189b9328f43d75158cfb2a417d40e57fcb5a4fb576"
    );
}

#[test]
fn webauthn_cose_key_matches_corpus_kat() {
    let cose_hex = "a50102032620012158206b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2962258204fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
    let cose_bytes: Vec<u8> = (0..cose_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&cose_hex[i..i + 2], 16).unwrap())
        .collect();
    let decoded = WebAuthnCborProfile::decode(&cose_bytes, LimitProfile::V1).unwrap();
    assert_eq!(decoded.kind(), WebAuthnCborKind::Es256CoseKey);
    let reencoded = WebAuthnCborProfile::encode(&decoded).unwrap();
    assert_eq!(
        reencoded, cose_bytes,
        "COSE key round-trip must preserve exact bytes"
    );
    use sha2::Digest;
    let hash: String = sha2::Sha256::digest(&cose_bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        hash, "72080e17877c7fe10b105ea40eea474975a16cf7773c03745aa64c025b6a4e63",
        "COSE key SHA-256 must match corpus"
    );
}
