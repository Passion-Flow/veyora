use crate::KernelError;

pub const MAX_OPAQUE_TEXT_BYTES: usize = 1_024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LimitProfile {
    max_document_bytes: usize,
    max_collection_items: usize,
    max_byte_string_bytes: usize,
    max_nesting_depth: usize,
    max_secret_text_bytes: usize,
}

impl LimitProfile {
    pub const V1: Self = Self {
        max_document_bytes: 4_259_840,
        max_collection_items: 4_096,
        max_byte_string_bytes: 4_194_304,
        max_nesting_depth: 32,
        max_secret_text_bytes: MAX_OPAQUE_TEXT_BYTES,
    };

    pub const fn new(
        max_document_bytes: usize,
        max_collection_items: usize,
        max_byte_string_bytes: usize,
        max_nesting_depth: usize,
        max_secret_text_bytes: usize,
    ) -> Result<Self, KernelError> {
        if max_document_bytes == 0
            || max_collection_items == 0
            || max_byte_string_bytes == 0
            || max_nesting_depth == 0
            || max_secret_text_bytes == 0
            || max_document_bytes > Self::V1.max_document_bytes
            || max_collection_items > Self::V1.max_collection_items
            || max_byte_string_bytes > Self::V1.max_byte_string_bytes
            || max_nesting_depth > Self::V1.max_nesting_depth
            || max_secret_text_bytes > Self::V1.max_secret_text_bytes
        {
            return Err(KernelError::LimitExceeded);
        }
        Ok(Self {
            max_document_bytes,
            max_collection_items,
            max_byte_string_bytes,
            max_nesting_depth,
            max_secret_text_bytes,
        })
    }

    #[must_use]
    pub const fn max_document_bytes(self) -> usize {
        self.max_document_bytes
    }

    #[must_use]
    pub const fn max_collection_items(self) -> usize {
        self.max_collection_items
    }

    #[must_use]
    pub const fn max_byte_string_bytes(self) -> usize {
        self.max_byte_string_bytes
    }

    #[must_use]
    pub const fn max_nesting_depth(self) -> usize {
        self.max_nesting_depth
    }

    #[must_use]
    pub const fn max_secret_text_bytes(self) -> usize {
        self.max_secret_text_bytes
    }
}
