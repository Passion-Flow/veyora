use kernel_core::{decode_opaque_secret, encode_opaque_secret};

#[test]
fn secret_text_is_never_normalized() {
    let original = " e\u{301}\u{200f}👩‍💻\n".as_bytes();
    let encoded = encode_opaque_secret(original).unwrap();
    let decoded = decode_opaque_secret(&encoded).unwrap();

    assert_eq!(decoded.as_slice(), original);
    assert_ne!(decoded.as_slice(), " é\u{200f}👩‍💻\n".as_bytes());
}

#[test]
fn length_aware_secret_api_preserves_an_entered_nul_scalar() {
    let original = "before\0after".as_bytes();
    let decoded = decode_opaque_secret(&encode_opaque_secret(original).unwrap()).unwrap();

    assert_eq!(decoded.as_slice(), original);
}

#[test]
fn malformed_empty_and_oversize_secret_text_rejects() {
    assert!(encode_opaque_secret(&[]).is_err());
    assert!(encode_opaque_secret(&[0xff]).is_err());
    assert!(encode_opaque_secret(&vec![b'a'; 1_025]).is_err());
    assert!(encode_opaque_secret(&vec![b'a'; 1_024]).is_ok());
}
