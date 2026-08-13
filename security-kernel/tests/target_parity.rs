use kernel_core::{LimitProfile, ProtocolCborProfile};

#[test]
fn native_wasm_and_ffi_safe_surfaces_share_protocol_bytes_and_errors() {
    let canonical = [0x82, 0x01, 0x41, 0xaa];
    let core = ProtocolCborProfile::decode(&canonical, LimitProfile::V1).unwrap();
    assert_eq!(ProtocolCborProfile::encode(&core).unwrap(), canonical);
    assert_eq!(
        kernel_wasm::validate_protocol_cbor_bytes(&canonical).unwrap(),
        canonical
    );
    assert_eq!(
        kernel_ffi::validate_protocol_cbor_bytes(&canonical).unwrap(),
        canonical
    );

    let invalid = [0x81, 0x18, 0x01];
    assert_eq!(
        kernel_wasm::validate_protocol_cbor_bytes(&invalid).unwrap_err(),
        "PM-KERNEL-NONCANONICAL-ENCODING"
    );
    assert_eq!(
        kernel_ffi::validate_protocol_cbor_bytes(&invalid)
            .unwrap_err()
            .stable_code(),
        "PM-KERNEL-NONCANONICAL-ENCODING"
    );
}
