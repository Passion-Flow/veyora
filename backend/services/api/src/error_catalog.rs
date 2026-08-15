//! Localized API error messages.
//!
//! Implements the localization half of the repository i18n contract
//! (`contracts/i18n/catalog-v1`): every stable error code carries one
//! human-readable message per supported locale. The stable code is always
//! part of the response body, so clients that ignore `Accept-Language`
//! keep working unchanged; the message is presentation only.

/// Terminal fallback locale: every code must be covered here.
pub const FALLBACK_LOCALE: &str = "en";

/// Locales with shipped error catalogs. Order defines primary-language
/// resolution (e.g. `zh` resolves to `zh-CN`).
pub static SUPPORTED_LOCALES: [&str; 10] = [
    "en", "zh-CN", "zh-TW", "ja", "ko", "de", "fr", "es", "ru", "ar",
];

/// One catalog row: a stable error code plus its message per locale.
struct CatalogRow {
    code: &'static str,
    messages: [&'static str; SUPPORTED_LOCALES.len()],
}

/// Column index for a locale tag (fallback column for unknown tags).
fn locale_index(locale: &str) -> usize {
    SUPPORTED_LOCALES
        .iter()
        .position(|supported| *supported == locale)
        .unwrap_or(0)
}

/// The closed error catalog. Indexes align with [`SUPPORTED_LOCALES`].
static CATALOG: &[CatalogRow] = &[
    CatalogRow {
        code: "PM-STORE-NOT-FOUND",
        messages: [
            "Record not found.",
            "记录不存在。",
            "記錄不存在。",
            "レコードが見つかりません。",
            "레코드를 찾을 수 없습니다.",
            "Datensatz nicht gefunden.",
            "Enregistrement introuvable.",
            "Registro no encontrado.",
            "Запись не найдена.",
            "السجل غير موجود.",
        ],
    },
    CatalogRow {
        code: "PM-STORE-CONFLICT",
        messages: [
            "Revision conflict: the record changed elsewhere.",
            "版本冲突：记录已在别处被修改。",
            "版本衝突：記錄已在別處被修改。",
            "リビジョン競合：レコードは別の場所で更新されています。",
            "리비전 충돌: 레코드가 다른 곳에서 변경되었습니다.",
            "Revisionskonflikt: der Datensatz wurde anderweitig geändert.",
            "Conflit de révision : l'enregistrement a été modifié ailleurs.",
            "Conflicto de revisión: el registro cambió en otro lugar.",
            "Конфликт ревизий: запись изменена в другом месте.",
            "تعارض في الإصدار: تم تعديل السجل في مكان آخر.",
        ],
    },
    CatalogRow {
        code: "PM-STORE-INVALID-RECORD",
        messages: [
            "Malformed record.",
            "记录格式无效。",
            "記錄格式無效。",
            "レコードの形式が不正です。",
            "레코드 형식이 잘못되었습니다.",
            "Ungültiger Datensatz.",
            "Enregistrement malformé.",
            "Registro malformado.",
            "Некорректная запись.",
            "تنسيق السجل غير صالح.",
        ],
    },
    CatalogRow {
        code: "PM-STORE-UNAVAILABLE",
        messages: [
            "Storage backend unavailable.",
            "存储后端不可用。",
            "儲存後端不可用。",
            "ストレージバックエンドが利用できません。",
            "스토리지 백엔드를 사용할 수 없습니다.",
            "Speicher-Backend nicht verfügbar.",
            "Backend de stockage indisponible.",
            "Backend de almacenamiento no disponible.",
            "Хранилище недоступно.",
            "خادم التخزين غير متاح.",
        ],
    },
    CatalogRow {
        code: "PM-API-ROUTE-MISMATCH",
        messages: [
            "Path and body record ids differ.",
            "路径与请求体中的记录 ID 不一致。",
            "路徑與請求主體中的記錄 ID 不一致。",
            "パスとリクエスト本体のレコード ID が一致しません。",
            "경로와 본문의 레코드 ID가 일치하지 않습니다.",
            "Pfad- und Body-Datensatz-IDs unterscheiden sich.",
            "Les identifiants d'enregistrement du chemin et du corps diffèrent.",
            "Los IDs de registro de la ruta y del cuerpo difieren.",
            "Идентификаторы записи в пути и теле запроса различаются.",
            "معرّف السجل في المسار لا يطابق المعرّف في النص.",
        ],
    },
    CatalogRow {
        code: "PM-API-BAD-BODY",
        messages: [
            "Request body could not be parsed.",
            "请求体无法解析。",
            "請求主體無法解析。",
            "リクエスト本体を解析できませんでした。",
            "요청 본문을 구문 분석할 수 없습니다.",
            "Anfragekörper konnte nicht geparst werden.",
            "Le corps de la requête n'a pas pu être analysé.",
            "No se pudo analizar el cuerpo de la solicitud.",
            "Не удалось разобрать тело запроса.",
            "تعذّر تحليل نص الطلب.",
        ],
    },
    CatalogRow {
        code: "PM-API-BODY-TOO-LARGE",
        messages: [
            "Request body exceeds the configured limit.",
            "请求体超出配置的大小限制。",
            "請求主體超出設定的大小上限。",
            "リクエスト本体が上限を超えています。",
            "요청 본문이 설정된 한도를 초과했습니다.",
            "Anfragekörper überschreitet das konfigurierte Limit.",
            "Le corps de la requête dépasse la limite configurée.",
            "El cuerpo de la solicitud supera el límite configurado.",
            "Тело запроса превышает установленный предел.",
            "يتجاوز نص الطلب الحد المُعد.",
        ],
    },
    CatalogRow {
        code: "PM-API-UNAUTHORIZED",
        messages: [
            "Missing or invalid bearer token.",
            "缺少或无效的 Bearer 令牌。",
            "缺少或無效的 Bearer 權杖。",
            "Bearer トークンが不在または無効です。",
            "Bearer 토큰이 없거나 유효하지 않습니다.",
            "Fehlendes oder ungültiges Bearer-Token.",
            "Jeton Bearer manquant ou invalide.",
            "Token Bearer ausente o no válido.",
            "Отсутствует или недействителен Bearer-токен.",
            "رمز Bearer مفقود أو غير صالح.",
        ],
    },
];

/// Resolve one `Accept-Language` header value to a supported locale.
///
/// Implements the q-value ordering and primary-language fallback the web
/// client also uses: exact tag match first, then the first supported locale
/// sharing the primary subtag, otherwise [`FALLBACK_LOCALE`].
pub fn negotiate_locale(header: Option<&str>) -> &'static str {
    let Some(header) = header else {
        return FALLBACK_LOCALE;
    };
    let mut candidates: Vec<(f32, &str)> = header.split(',').filter_map(parse_entry).collect();
    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    for (_, tag) in candidates {
        let tag = tag.trim();
        if let Some(matched) = SUPPORTED_LOCALES
            .iter()
            .find(|supported| **supported == tag)
            .or_else(|| {
                let primary = tag.split('-').next().unwrap_or(tag);
                SUPPORTED_LOCALES
                    .iter()
                    .find(|supported| supported.starts_with(primary))
            })
        {
            return matched;
        }
    }
    FALLBACK_LOCALE
}

fn parse_entry(entry: &str) -> Option<(f32, &str)> {
    let mut parts = entry.split(';');
    let tag = parts.next()?.trim();
    if tag.is_empty()
        || !tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    let quality = parts
        .next()
        .and_then(|param| param.trim().strip_prefix("q="))
        .and_then(|value| value.trim().parse::<f32>().ok())
        .unwrap_or(1.0);
    Some((quality, tag))
}

/// Message for codes outside the catalog.
const UNKNOWN_CODE_MESSAGE: &str = "Unspecified error.";

/// Look up the localized message for a stable error code.
/// Unknown codes and locales fall back to English.
pub fn localized_message(code: &str, locale: &str) -> &'static str {
    let column = locale_index(locale);
    CATALOG
        .iter()
        .find(|row| row.code == code)
        .map(|row| row.messages[column])
        .unwrap_or(UNKNOWN_CODE_MESSAGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_prefers_exact_match() {
        assert_eq!(negotiate_locale(Some("zh-CN")), "zh-CN");
        assert_eq!(negotiate_locale(Some("ja-JP,ja;q=0.9")), "ja");
    }

    #[test]
    fn negotiation_orders_by_quality() {
        assert_eq!(negotiate_locale(Some("ja;q=0.9,ko;q=1.0")), "ko");
        assert_eq!(negotiate_locale(Some("de;q=0.4,fr;q=0.8")), "fr");
    }

    #[test]
    fn negotiation_falls_back_to_primary_language() {
        assert_eq!(negotiate_locale(Some("zh-HK")), "zh-CN");
        assert_eq!(negotiate_locale(Some("pt-BR,pt;q=0.9,en;q=0.2")), "en");
    }

    #[test]
    fn negotiation_defaults_without_header_or_known_locale() {
        assert_eq!(negotiate_locale(None), FALLBACK_LOCALE);
        assert_eq!(negotiate_locale(Some("xx-YY")), FALLBACK_LOCALE);
    }

    #[test]
    fn every_code_has_every_locale() {
        for row in CATALOG {
            for (index, message) in row.messages.iter().enumerate() {
                assert!(
                    !message.is_empty(),
                    "{} locale {}",
                    row.code,
                    SUPPORTED_LOCALES[index]
                );
            }
        }
    }

    #[test]
    fn messages_localize_and_fall_back() {
        assert_eq!(
            localized_message("PM-STORE-NOT-FOUND", "zh-CN"),
            "记录不存在。"
        );
        assert_eq!(
            localized_message("PM-STORE-NOT-FOUND", "unknown"),
            "Record not found."
        );
        assert_eq!(
            localized_message("PM-API-UNAUTHORIZED", "ar"),
            "رمز Bearer مفقود أو غير صالح."
        );
        assert_eq!(
            localized_message("PM-UNKNOWN-CODE", "en"),
            UNKNOWN_CODE_MESSAGE
        );
    }
}
