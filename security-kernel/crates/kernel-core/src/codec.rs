use minicbor::{Decoder, Encoder, data::Type, encode::write::Write};
use p256::PublicKey;

use crate::{KernelError, LimitProfile};

#[derive(Debug, Default)]
struct FallibleBytes(Vec<u8>);

impl FallibleBytes {
    fn into_inner(self) -> Vec<u8> {
        self.0
    }
}

impl Write for FallibleBytes {
    type Error = KernelError;

    fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
        self.0
            .try_reserve_exact(bytes.len())
            .map_err(|_| KernelError::LimitExceeded)?;
        self.0.extend_from_slice(bytes);
        Ok(())
    }
}

fn copy_bytes(bytes: &[u8]) -> Result<Vec<u8>, KernelError> {
    let mut owned = Vec::new();
    owned
        .try_reserve_exact(bytes.len())
        .map_err(|_| KernelError::LimitExceeded)?;
    owned.extend_from_slice(bytes);
    Ok(owned)
}

fn map_encode_error(error: minicbor::encode::Error<KernelError>) -> KernelError {
    error.into_write().unwrap_or(KernelError::InvalidEncoding)
}

pub trait CanonicalCodec {
    type Document;

    fn decode(bytes: &[u8], limits: LimitProfile) -> Result<Self::Document, KernelError>;
    fn encode(document: &Self::Document) -> Result<Vec<u8>, KernelError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ProtocolItem {
    Unsigned(u64),
    Bytes(Vec<u8>),
    Boolean(bool),
    Array(Vec<Self>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalProtocolCbor {
    bytes: Vec<u8>,
    item: ProtocolItem,
}

impl CanonicalProtocolCbor {
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WebAuthnCborKind {
    NoneAttestationObject,
    Es256CoseKey,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum WebAuthnItem {
    NoneAttestation { authenticator_data: Vec<u8> },
    Es256CoseKey { x: [u8; 32], y: [u8; 32] },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalWebAuthnCbor {
    bytes: Vec<u8>,
    item: WebAuthnItem,
}

impl CanonicalWebAuthnCbor {
    #[must_use]
    pub const fn kind(&self) -> WebAuthnCborKind {
        match self.item {
            WebAuthnItem::NoneAttestation { .. } => WebAuthnCborKind::NoneAttestationObject,
            WebAuthnItem::Es256CoseKey { .. } => WebAuthnCborKind::Es256CoseKey,
        }
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ProtocolCborProfile;

impl ProtocolCborProfile {
    pub fn decode(
        bytes: &[u8],
        limits: LimitProfile,
    ) -> Result<CanonicalProtocolCbor, KernelError> {
        <Self as CanonicalCodec>::decode(bytes, limits)
    }

    pub fn encode(document: &CanonicalProtocolCbor) -> Result<Vec<u8>, KernelError> {
        <Self as CanonicalCodec>::encode(document)
    }
}

impl CanonicalCodec for ProtocolCborProfile {
    type Document = CanonicalProtocolCbor;

    fn decode(bytes: &[u8], limits: LimitProfile) -> Result<Self::Document, KernelError> {
        if bytes.is_empty() || bytes.len() > limits.max_document_bytes() {
            return Err(KernelError::LimitExceeded);
        }
        let mut decoder = Decoder::new(bytes);
        if decoder
            .datatype()
            .map_err(|_| KernelError::InvalidEncoding)?
            != Type::Array
        {
            return Err(KernelError::InvalidEncoding);
        }
        let mut item_count = 0_usize;
        let item = decode_protocol_item(&mut decoder, limits, 1, &mut item_count)?;
        if decoder.position() != bytes.len() {
            return Err(KernelError::InvalidEncoding);
        }
        let canonical = encode_protocol_item_to_vec(&item)?;
        if canonical != bytes {
            return Err(KernelError::NonCanonicalEncoding);
        }
        Ok(CanonicalProtocolCbor {
            bytes: canonical,
            item,
        })
    }

    fn encode(document: &Self::Document) -> Result<Vec<u8>, KernelError> {
        encode_protocol_item_to_vec(&document.item)
    }
}

fn decode_protocol_item(
    decoder: &mut Decoder<'_>,
    limits: LimitProfile,
    depth: usize,
    item_count: &mut usize,
) -> Result<ProtocolItem, KernelError> {
    if depth > limits.max_nesting_depth() {
        return Err(KernelError::LimitExceeded);
    }
    *item_count = item_count
        .checked_add(1)
        .ok_or(KernelError::LimitExceeded)?;
    if *item_count > limits.max_collection_items() {
        return Err(KernelError::LimitExceeded);
    }
    match decoder
        .datatype()
        .map_err(|_| KernelError::InvalidEncoding)?
    {
        Type::U8 | Type::U16 | Type::U32 | Type::U64 => {
            let value = decoder.u64().map_err(|_| KernelError::InvalidEncoding)?;
            if value > i64::MAX as u64 {
                return Err(KernelError::InvalidEncoding);
            }
            Ok(ProtocolItem::Unsigned(value))
        }
        Type::Bytes => {
            let bytes = decoder.bytes().map_err(|_| KernelError::InvalidEncoding)?;
            if bytes.len() > limits.max_byte_string_bytes() {
                return Err(KernelError::LimitExceeded);
            }
            Ok(ProtocolItem::Bytes(copy_bytes(bytes)?))
        }
        Type::Bool => Ok(ProtocolItem::Boolean(
            decoder.bool().map_err(|_| KernelError::InvalidEncoding)?,
        )),
        Type::Array => {
            let length = decoder
                .array()
                .map_err(|_| KernelError::InvalidEncoding)?
                .ok_or(KernelError::InvalidEncoding)?;
            let length: usize = length.try_into().map_err(|_| KernelError::LimitExceeded)?;
            let remaining_bytes = decoder.input().len().saturating_sub(decoder.position());
            if length > remaining_bytes {
                return Err(KernelError::InvalidEncoding);
            }
            if length > limits.max_collection_items().saturating_sub(*item_count) {
                return Err(KernelError::LimitExceeded);
            }
            let mut values = Vec::new();
            values
                .try_reserve_exact(length)
                .map_err(|_| KernelError::LimitExceeded)?;
            for _ in 0..length {
                values.push(decode_protocol_item(
                    decoder,
                    limits,
                    depth + 1,
                    item_count,
                )?);
            }
            Ok(ProtocolItem::Array(values))
        }
        _ => Err(KernelError::InvalidEncoding),
    }
}

fn encode_protocol_item_to_vec(item: &ProtocolItem) -> Result<Vec<u8>, KernelError> {
    let mut encoder = Encoder::new(FallibleBytes::default());
    encode_protocol_item(&mut encoder, item)?;
    Ok(encoder.into_writer().into_inner())
}

fn encode_protocol_item(
    encoder: &mut Encoder<FallibleBytes>,
    item: &ProtocolItem,
) -> Result<(), KernelError> {
    match item {
        ProtocolItem::Unsigned(value) => {
            encoder.u64(*value).map_err(map_encode_error)?;
        }
        ProtocolItem::Bytes(bytes) => {
            encoder.bytes(bytes).map_err(map_encode_error)?;
        }
        ProtocolItem::Boolean(value) => {
            encoder.bool(*value).map_err(map_encode_error)?;
        }
        ProtocolItem::Array(values) => {
            encoder
                .array(values.len() as u64)
                .map_err(map_encode_error)?;
            for value in values {
                encode_protocol_item(encoder, value)?;
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WebAuthnCborProfile;

impl WebAuthnCborProfile {
    pub fn decode(
        bytes: &[u8],
        limits: LimitProfile,
    ) -> Result<CanonicalWebAuthnCbor, KernelError> {
        <Self as CanonicalCodec>::decode(bytes, limits)
    }

    pub fn encode(document: &CanonicalWebAuthnCbor) -> Result<Vec<u8>, KernelError> {
        <Self as CanonicalCodec>::encode(document)
    }
}

impl CanonicalCodec for WebAuthnCborProfile {
    type Document = CanonicalWebAuthnCbor;

    fn decode(bytes: &[u8], limits: LimitProfile) -> Result<Self::Document, KernelError> {
        if bytes.is_empty() || bytes.len() > limits.max_document_bytes() {
            return Err(KernelError::LimitExceeded);
        }
        let mut decoder = Decoder::new(bytes);
        let length = decoder
            .map()
            .map_err(|_| KernelError::InvalidEncoding)?
            .ok_or(KernelError::InvalidEncoding)?;
        let item = match length {
            3 => decode_none_attestation(&mut decoder, limits)?,
            5 => decode_es256_cose_key(&mut decoder)?,
            _ => return Err(KernelError::InvalidEncoding),
        };
        if decoder.position() != bytes.len() {
            return Err(KernelError::InvalidEncoding);
        }
        let canonical = encode_webauthn_item(&item)?;
        if canonical != bytes {
            return Err(KernelError::NonCanonicalEncoding);
        }
        Ok(CanonicalWebAuthnCbor {
            bytes: canonical,
            item,
        })
    }

    fn encode(document: &Self::Document) -> Result<Vec<u8>, KernelError> {
        encode_webauthn_item(&document.item)
    }
}

fn decode_none_attestation(
    decoder: &mut Decoder<'_>,
    limits: LimitProfile,
) -> Result<WebAuthnItem, KernelError> {
    if decoder.str().map_err(|_| KernelError::InvalidEncoding)? != "fmt"
        || decoder.str().map_err(|_| KernelError::InvalidEncoding)? != "none"
        || decoder.str().map_err(|_| KernelError::InvalidEncoding)? != "attStmt"
        || decoder
            .map()
            .map_err(|_| KernelError::InvalidEncoding)?
            .ok_or(KernelError::InvalidEncoding)?
            != 0
        || decoder.str().map_err(|_| KernelError::InvalidEncoding)? != "authData"
    {
        return Err(KernelError::InvalidEncoding);
    }
    let authenticator_data = decoder.bytes().map_err(|_| KernelError::InvalidEncoding)?;
    if !(37..=1_024.min(limits.max_byte_string_bytes())).contains(&authenticator_data.len()) {
        return Err(KernelError::LimitExceeded);
    }
    Ok(WebAuthnItem::NoneAttestation {
        authenticator_data: copy_bytes(authenticator_data)?,
    })
}

fn decode_es256_cose_key(decoder: &mut Decoder<'_>) -> Result<WebAuthnItem, KernelError> {
    if decoder.i64().map_err(|_| KernelError::InvalidEncoding)? != 1
        || decoder.i64().map_err(|_| KernelError::InvalidEncoding)? != 2
        || decoder.i64().map_err(|_| KernelError::InvalidEncoding)? != 3
        || decoder.i64().map_err(|_| KernelError::InvalidEncoding)? != -7
        || decoder.i64().map_err(|_| KernelError::InvalidEncoding)? != -1
        || decoder.i64().map_err(|_| KernelError::InvalidEncoding)? != 1
        || decoder.i64().map_err(|_| KernelError::InvalidEncoding)? != -2
    {
        return Err(KernelError::InvalidEncoding);
    }
    let x: [u8; 32] = decoder
        .bytes()
        .map_err(|_| KernelError::InvalidEncoding)?
        .try_into()
        .map_err(|_| KernelError::InvalidEncoding)?;
    if decoder.i64().map_err(|_| KernelError::InvalidEncoding)? != -3 {
        return Err(KernelError::InvalidEncoding);
    }
    let y: [u8; 32] = decoder
        .bytes()
        .map_err(|_| KernelError::InvalidEncoding)?
        .try_into()
        .map_err(|_| KernelError::InvalidEncoding)?;
    let mut encoded_point = [0_u8; 65];
    encoded_point[0] = 4;
    encoded_point[1..33].copy_from_slice(&x);
    encoded_point[33..].copy_from_slice(&y);
    PublicKey::from_sec1_bytes(&encoded_point).map_err(|_| KernelError::InvalidEncoding)?;
    Ok(WebAuthnItem::Es256CoseKey { x, y })
}

fn encode_webauthn_item(item: &WebAuthnItem) -> Result<Vec<u8>, KernelError> {
    let mut encoder = Encoder::new(FallibleBytes::default());
    match item {
        WebAuthnItem::NoneAttestation { authenticator_data } => {
            encoder
                .map(3)
                .and_then(|encoder| encoder.str("fmt"))
                .and_then(|encoder| encoder.str("none"))
                .and_then(|encoder| encoder.str("attStmt"))
                .and_then(|encoder| encoder.map(0))
                .and_then(|encoder| encoder.str("authData"))
                .and_then(|encoder| encoder.bytes(authenticator_data))
                .map_err(map_encode_error)?;
        }
        WebAuthnItem::Es256CoseKey { x, y } => {
            encoder
                .map(5)
                .and_then(|encoder| encoder.i64(1))
                .and_then(|encoder| encoder.i64(2))
                .and_then(|encoder| encoder.i64(3))
                .and_then(|encoder| encoder.i64(-7))
                .and_then(|encoder| encoder.i64(-1))
                .and_then(|encoder| encoder.i64(1))
                .and_then(|encoder| encoder.i64(-2))
                .and_then(|encoder| encoder.bytes(x))
                .and_then(|encoder| encoder.i64(-3))
                .and_then(|encoder| encoder.bytes(y))
                .map_err(map_encode_error)?;
        }
    }
    Ok(encoder.into_writer().into_inner())
}
