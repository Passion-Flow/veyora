//! Stable API error codes with fixed English messages (LANG-003).
//!
//! The API MUST NOT embed translated prose: the stable ASCII code is the
//! contract and the English message is a debugging aid only. User-facing
//! localization is a client concern; the web client renders API codes
//! through its own locale catalog (`apiError.*` keys in
//! `apps/web/locales/`).
//!
//! DIAG-003 completeness is enforced by tests in three directions: every
//! `PM-*` literal used in the API sources must be cataloged here, every
//! catalog code must be documented in `docs/reference/api.md` so it is
//! searchable in English documentation, and every documented code must
//! exist in the catalog.

/// Message for codes outside the catalog.
pub const UNKNOWN_CODE_MESSAGE: &str = "Unspecified error.";

/// The closed error catalog: stable ASCII code plus fixed English message.
static CATALOG: &[(&str, &str)] = &[
    ("PM-STORE-NOT-FOUND", "Record not found."),
    (
        "PM-STORE-CONFLICT",
        "Revision conflict: the record changed elsewhere.",
    ),
    ("PM-STORE-INVALID-RECORD", "Malformed record."),
    ("PM-STORE-UNAVAILABLE", "Storage backend unavailable."),
    ("PM-API-ROUTE-MISMATCH", "Path and body record ids differ."),
    ("PM-API-BAD-BODY", "Request body could not be parsed."),
    ("PM-API-BAD-QUERY", "Query string could not be parsed."),
    (
        "PM-API-BODY-TOO-LARGE",
        "Request body exceeds the configured limit.",
    ),
    ("PM-API-UNAUTHORIZED", "Missing or invalid bearer token."),
    ("PM-API-RATE-LIMITED", "Too many requests; retry later."),
];

/// Look up the fixed English message for a stable error code.
/// Unknown codes fall back to [`UNKNOWN_CODE_MESSAGE`].
pub fn message(code: &str) -> &'static str {
    CATALOG
        .iter()
        .find(|(known, _)| *known == code)
        .map(|(_, message)| *message)
        .unwrap_or(UNKNOWN_CODE_MESSAGE)
}

/// Whether `code` is a cataloged stable error code.
pub fn is_known(code: &str) -> bool {
    CATALOG.iter().any(|(known, _)| *known == code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_codes_have_messages() {
        assert_eq!(message("PM-STORE-NOT-FOUND"), "Record not found.");
        assert_eq!(
            message("PM-STORE-CONFLICT"),
            "Revision conflict: the record changed elsewhere."
        );
    }

    #[test]
    fn unknown_codes_fall_back() {
        assert_eq!(message("PM-UNKNOWN-CODE"), UNKNOWN_CODE_MESSAGE);
        assert!(!is_known("PM-UNKNOWN-CODE"));
    }

    #[test]
    fn catalog_is_ascii_only() {
        for (code, text) in CATALOG {
            assert!(code.is_ascii(), "code must be ASCII: {code}");
            assert!(text.is_ascii(), "message must be English ASCII: {text}");
        }
    }

    /// DIAG-003: codes are unique and match the stable `PM-NAMESPACE-NAME`
    /// shape so they stay searchable and greppable.
    #[test]
    fn codes_are_unique_and_wellformed() {
        let mut seen = std::collections::BTreeSet::new();
        for (code, text) in CATALOG {
            assert!(
                code.starts_with("PM-") && code.chars().all(|c| c.is_ascii_uppercase() || c == '-'),
                "code must be uppercase ASCII with dashes: {code}"
            );
            assert!(seen.insert(code), "duplicate catalog code: {code}");
            assert!(!text.is_empty(), "empty message for {code}");
        }
    }

    /// Extract the next complete `PM-UPPER-CASE` literal starting at or
    /// after `from`, if any. Prose such as `PM-*` is not a literal.
    fn next_code_literal(text: &str) -> Option<(String, usize)> {
        let mut search = 0;
        while let Some(start) = text[search..].find("PM-") {
            let start = search + start;
            let literal: String = text[start..]
                .chars()
                .take_while(|c| c.is_ascii_uppercase() || *c == '-')
                .collect();
            // A real code has at least one uppercase segment after "PM-".
            if literal.len() > "PM-".len() {
                let code = literal.trim_end_matches('-').to_string();
                if code.len() > "PM".len() {
                    return Some((code, start + literal.len()));
                }
            }
            search = start + "PM-".len();
        }
        None
    }

    /// Collect every code literal in a document, in order.
    fn all_code_literals(text: &str) -> Vec<String> {
        let mut found = Vec::new();
        let mut remainder = text;
        while let Some((code, consumed)) = next_code_literal(remainder) {
            found.push(code);
            remainder = &remainder[consumed..];
        }
        found
    }

    /// DIAG-003: every `PM-*` literal emitted anywhere in the API handlers
    /// must be a cataloged stable code, so no operational error path can
    /// escape the closed catalog.
    #[test]
    fn every_source_code_literal_is_cataloged() {
        for (name, source) in [
            ("lib.rs", include_str!("lib.rs")),
            ("main.rs", include_str!("main.rs")),
        ] {
            for code in all_code_literals(source) {
                assert!(
                    is_known(&code),
                    "{name} emits uncataloged error code: {code}"
                );
            }
        }
    }

    /// DIAG-003: every catalog code must be searchable in the English API
    /// documentation, and the documentation must not promise codes that
    /// the catalog no longer contains.
    #[test]
    fn documentation_and_catalog_are_in_sync() {
        let doc = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/reference/api.md"
        ))
        .expect("docs/reference/api.md must be readable");
        for (code, _) in CATALOG {
            assert!(
                doc.contains(code),
                "code missing from docs/reference/api.md: {code}"
            );
        }
        for code in all_code_literals(&doc) {
            assert!(
                is_known(&code),
                "documentation references uncataloged code: {code}"
            );
        }
    }
}
