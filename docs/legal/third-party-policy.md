# Third-party rights and inventory policy

The Veyora first-party license applies only to rights the licensor can grant.
Every dependency, base image, operating-system package, Gateway component, font,
translation, fixture, vector, schema/text extract, generated or vendored file,
copied document, and future brand asset keeps its own rights.

Each material shipped in an image, Web bundle, native package, or Compose archive
must have a human-reviewed inventory row with:

| Field | Required meaning |
|---|---|
| `name` and `source` | Stable identity and authoritative origin |
| `version` and `sha256` | Exact reviewed bytes |
| `declared_license` | Upstream declaration |
| `concluded_license` | Human conclusion for the distributed material |
| `required_notices` | Exact text and license files to propagate |
| `propagated_notices` | Exact shipped paths for every required notice |
| `modified` | Whether and how Veyora changed it |
| `distribution_paths` | Every package/image location |
| `human_disposition` | `approved`, `approved-with-notice`, `denied`, or `pending` |

An inventory may declare `release_eligibility: eligible` only when every entry
has an `approved` or `approved-with-notice` human disposition, neither license
field is `NOASSERTION`, pending, unknown, or custom-unreviewed, and the shipped
notice set contains every required notice path. A pending or denied disposition,
an unresolved license, a missing source, or an unpropagated notice makes the
inventory `blocked` and blocks the affected artifact. Scanners and SBOM
generators provide evidence; they do not provide legal advice or prove ownership,
originality, compatibility, or non-infringement.

Font names, icons, translations, generated assets, copied standards prose, and
test vectors require the same review. No future logo or icon may be inventoried
as a Veyora asset until its creator, source, date, rights, originality review,
approved terms, and digest exist.
