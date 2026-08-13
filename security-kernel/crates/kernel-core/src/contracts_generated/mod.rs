// GENERATED: edit contracts/, then run generate-bindings.py.
// Kernel binding contains data types only and imports no transport/runtime crate.
pub const CONTRACT_SOURCE_DIGEST: &str =
    "sha256:210681c3d5ac2ebc1d3063085e4b9f1138a24674d0293c3a1d35d30730afdc26";

pub const PROTOCOL_VERSION: u16 = 1;
pub const SUITE_ID: u16 = 1;
pub const RELEASE_VERSION: &str = "v1.0.0";
pub const RECORD_ENVELOPE_DOMAIN: &[u8] = b"pm-v1/record-envelope";
pub const RECORD_PLAINTEXT_BUCKET_MAX_BYTES: u64 = 16777216;
pub const RECORD_CIPHERTEXT_MAX_BYTES: u64 = 16777232;
pub const BACKUP_CHUNK_BYTES: u64 = 4194304;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolInvariantsV1 {
    pub schema_version: u16,
    pub protocol_version: u16,
    pub suite_id: u16,
    pub account_state_version: u16,
    pub backup_format_version: u16,
    pub release_version: String,
    pub normative_documents: Vec<NormativeDocumentV1>,
    pub cddl_structures: Vec<CddlStructureV1>,
    pub invariants: Vec<ProtocolInvariantV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormativeDocumentV1 {
    pub path: String,
    pub sha256: String,
    pub assignments: std::collections::BTreeMap<String, u64>,
    pub required_domains: std::collections::BTreeMap<String, u64>,
    pub required_domain_patterns: std::collections::BTreeMap<String, u64>,
    pub required_algorithms: std::collections::BTreeMap<String, u64>,
    pub fenced_structures: Vec<FencedStructureV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FencedStructureV1 {
    pub section: String,
    pub ordinal: u64,
    pub language: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CddlStructureV1 {
    pub path: String,
    pub rule: String,
    pub elements: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InvariantValueV1 {
    Integer(u64),
    Text(String),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolInvariantV1 {
    pub id: String,
    pub value: InvariantValueV1,
    pub configurable: bool,
    pub source: String,
    pub consumers: Vec<String>,
    pub migration: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayV1 {
    pub operation_id: String,
    pub path: String,
    pub method: String,
    pub request_ref: Option<String>,
    pub responses: Vec<GatewayResponseV1>,
    pub authorization: Vec<GatewayTransportAuthorizationV1>,
    pub request_wire: Option<GatewayWireMetadataV1>,
    pub response_wire: Option<GatewayWireMetadataV1>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayResponseV1 {
    pub status_code: String,
    pub response_ref: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayTransportAuthorizationV1 {
    Public,
    SessionCookie,
    SessionCookieAndCsrf,
    DeviceAuthorization,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayWireMetadataV1 {
    pub contract_id: String,
    pub state_binding: String,
    pub operation_class: String,
    pub cryptographic_authorization: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GenericEncryptedRecordV1 {
    pub protocol_version: u16,
    pub suite_id: u16,
    pub deployment_id: String,
    pub vault_id: String,
    pub record_id: String,
    pub revision: u64,
    pub ciphertext: String,
    pub ciphertext_hash: String,
    pub ciphertext_length: u64,
    pub tombstone: bool,
    pub template_envelope_hash: String,
    pub manifest_binding: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackupHeaderCoreV1 {
    pub protocol_version: u16,
    pub suite_id: u16,
    pub format_version: u16,
    pub deployment_id: [u8; 16],
    pub vault_id: [u8; 16],
    pub backup_id: [u8; 16],
    pub backup_key_id: [u8; 16],
    pub database_schema_version: u64,
    pub release_schema_hash: [u8; 32],
    pub manifest_revision: u64,
    pub manifest_envelope_hash: [u8; 32],
    pub account_state_revision: u64,
    pub account_state_root: [u8; 32],
    pub checkpoint_reference: Option<Vec<u8>>,
    pub chunk_bytes: u64,
    pub logical_size: u64,
    pub data_chunk_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackupHeaderV1 {
    pub protocol_version: u16,
    pub suite_id: u16,
    pub format_version: u16,
    pub deployment_id: [u8; 16],
    pub vault_id: [u8; 16],
    pub backup_id: [u8; 16],
    pub backup_key_id: [u8; 16],
    pub database_schema_version: u64,
    pub release_schema_hash: [u8; 32],
    pub manifest_revision: u64,
    pub manifest_envelope_hash: [u8; 32],
    pub account_state_revision: u64,
    pub account_state_root: [u8; 32],
    pub checkpoint_reference: Option<Vec<u8>>,
    pub chunk_bytes: u64,
    pub logical_size: u64,
    pub data_chunk_count: u64,
    pub stream_header: [u8; 24],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackupArtifactV1 {
    pub schema_version: u16,
    pub media_type: String,
    pub protocol_chunk_bytes: u64,
    pub storage_buffer_bytes: u64,
    pub data_frame_overhead: u64,
    pub message_tag: String,
    pub message_tag_value: u8,
    pub final_tag: String,
    pub final_tag_value: u8,
    pub frame_order: String,
    pub aad_domain: String,
    pub final_plaintext_fields: Vec<String>,
    pub artifact_length_equation: String,
    pub trailing_bytes: String,
    pub goldens: Vec<String>,
    pub golden_evidence_status: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseSetV1 {
    pub schema_version: u16,
    pub version: String,
    pub source_commit: String,
    pub candidate_id: String,
    pub predecessor_candidate_id: Option<String>,
    pub migration: MigrationDispositionV1,
    pub toolchain_lock_sha256: String,
    pub contracts_sha256: String,
    pub brand_sha256: String,
    pub images: ReleaseImagesV1,
    pub test_auxiliary_images: Vec<TestAuxiliaryImageSubjectV1>,
    pub clients: Vec<ClientDispositionV1>,
    pub publication_status: ExternalStatusV1,
    pub production_signing_status: ExternalStatusV1,
    pub deployment_status: ExternalStatusV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MigrationDispositionV1 {
    None,
    ExpandCompatible,
    RestoreForwardRequired,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExternalStatusV1 {
    NotAuthorized,
    NotPerformed,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServiceNameV1 {
    Gateway,
    Api,
    Worker,
    Web,
    Sandbox,
    Migrator,
    Backup,
    Restore,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImagePlatformV1 {
    LinuxAmd64,
    LinuxArm64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientPlatformV1 {
    Linux,
    Macos,
    Windows,
    AndroidArm64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientArtifactStatusV1 {
    VerifiedIncluded,
    ExcludedUnverified,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseImagesV1 {
    pub gateway: ImageSubjectV1,
    pub api: ImageSubjectV1,
    pub worker: ImageSubjectV1,
    pub web: ImageSubjectV1,
    pub sandbox: ImageSubjectV1,
    pub migrator: ImageSubjectV1,
    pub backup: ImageSubjectV1,
    pub restore: ImageSubjectV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformImageSubjectV1 {
    pub platform: ImagePlatformV1,
    pub archive_sha256: String,
    pub repository: String,
    pub loadable_root_digest: String,
    pub manifest_digest: String,
    pub config_digest: String,
    pub layer_digests: Vec<String>,
    pub sbom_sha256: String,
    pub provenance_sha256: String,
    pub scan_sha256: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageSubjectV1 {
    pub service: ServiceNameV1,
    pub oci_index_digest: String,
    pub linux_amd64_child_digest: String,
    pub linux_arm64_child_digest: String,
    pub platforms: [PlatformImageSubjectV1; 2],
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TestAuxiliaryImageSubjectV1 {
    pub purpose: String,
    pub name: String,
    pub production_eligible: bool,
    pub platforms: [PlatformImageSubjectV1; 2],
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientDispositionV1 {
    pub platform: ClientPlatformV1,
    pub target_triple: String,
    pub package_format: String,
    pub abi: Option<String>,
    pub status: ClientArtifactStatusV1,
    pub artifact_sha256: Option<String>,
    pub evidence_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimPolicyV1 {
    pub schema_version: u16,
    pub categories: Vec<String>,
    pub availability_states: Vec<String>,
    pub prohibited_phrases: Vec<String>,
    pub claims: Vec<ClaimEntryV1>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimEntryV1 {
    pub id: String,
    pub category: String,
    pub state: String,
    pub qualifier: Option<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InterchangeV1 {
    pub schema_version: u16,
    pub media_type: String,
    pub encoding: String,
    pub line_endings: String,
    pub header_line: u16,
    pub record_lines: String,
    pub duplicate_keys: String,
    pub transaction: String,
    pub publish: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratorPolicyV1 {
    pub schema_version: u16,
    pub length: GeneratorLengthV1,
    pub classes: GeneratorClassesV1,
    pub selection: String,
    pub random_source: String,
    pub empty_alphabet: String,
    pub output_handling: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratorLengthV1 {
    pub default: u16,
    pub minimum: u16,
    pub maximum: u16,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratorClassesV1 {
    pub uppercase: String,
    pub lowercase: String,
    pub numbers: String,
    pub symbols: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolchainLockV1 {
    pub schema_version: u16,
    pub release: String,
    pub policy: String,
    pub dependency_authority: String,
    pub tools: Vec<ToolchainToolV1>,
    pub reviewed_dependencies: Vec<ReviewedDependencyV1>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolchainToolV1 {
    pub id: String,
    pub version: Option<String>,
    pub version_status: Option<String>,
    pub features: Option<Vec<String>>,
    pub digest_status: String,
    pub license_review: String,
    pub provenance: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewedDependencyV1 {
    pub id: String,
    pub version: String,
    pub features: Vec<String>,
    pub targets: Vec<String>,
    pub license_review: String,
    pub msrv_review: String,
    pub provenance: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ErrorRescueRegistryV1 {
    pub schema_version: u16,
    pub rescue_actions: Vec<String>,
    pub errors: Vec<RescueErrorV1>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RescueErrorV1 {
    pub code: String,
    pub message_id: String,
    pub http_status: u16,
    pub ipc_status: String,
    pub retry: String,
    pub rescue_action: String,
    pub log_class: String,
    pub redaction: String,
    pub docs_ref: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceCapabilitiesV1 {
    pub schema_version: u16,
    pub default: String,
    pub services: ServiceCapabilityMapV1,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceCapabilityMapV1 {
    pub gateway: ServiceCapabilityV1,
    pub api: ServiceCapabilityV1,
    pub worker: ServiceCapabilityV1,
    pub web: ServiceCapabilityV1,
    pub sandbox: ServiceCapabilityV1,
    pub migrator: ServiceCapabilityV1,
    pub backup: ServiceCapabilityV1,
    pub restore: ServiceCapabilityV1,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceCapabilityV1 {
    pub routes: Vec<String>,
    pub database_operations: Vec<String>,
    pub secret_files: Vec<String>,
    pub network_targets: Vec<String>,
    pub volumes: Vec<String>,
    pub stdin: Option<Vec<String>>,
    pub jobs: Vec<String>,
    pub observability: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservabilityPrivacyV1 {
    pub schema_version: u16,
    pub default: String,
    pub metrics: Vec<ObservabilityMetricV1>,
    pub traces: Vec<ObservabilityTraceV1>,
    pub alerts: Vec<ObservabilityAlertV1>,
    pub forbidden: Vec<String>,
    pub export: ObservabilityExportV1,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservabilityMetricV1 {
    pub name: String,
    pub kind: String,
    pub labels: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservabilityTraceV1 {
    pub name: String,
    pub fields: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservabilityAlertV1 {
    pub id: String,
    pub threshold_source: String,
    pub window_source: String,
    pub severity: String,
    pub owner: String,
    pub runbook_id: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservabilityExportV1 {
    pub metrics_network: String,
    pub trace_default: String,
    pub alert_destination: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeBudgetsV1 {
    pub schema_version: u16,
    pub budgets: std::collections::BTreeMap<String, RuntimeBudgetV1>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeBudgetV1 {
    Registry(RegistryBudgetV1),
    ProtocolInvariant(ProtocolInvariantBudgetV1),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryBudgetV1 {
    pub value: u64,
    pub source: String,
    pub registry_id: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolInvariantBudgetV1 {
    pub value: u64,
    pub source: String,
    pub invariant_id: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorCommandV1 {
    pub schema_version: u16,
    pub program: String,
    pub flags: std::collections::BTreeMap<String, OperatorFlagV1>,
    pub commands: Vec<OperatorCommandEntryV1>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorFlagV1 {
    pub values: Option<Vec<String>>,
    pub kind: Option<String>,
    pub default: Option<OperatorFlagDefaultV1>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OperatorFlagDefaultV1 {
    Boolean(bool),
    String(String),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorCommandEntryV1 {
    pub path: Vec<String>,
    pub flags: Vec<String>,
    pub idempotency: String,
    pub cancellation: String,
    pub side_effect: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorResultV1 {
    pub schema_version: u16,
    pub command: String,
    pub status: String,
    pub code: String,
    pub message_id: String,
    pub summary: String,
    pub operation_id: Option<String>,
    pub resume_available: bool,
    pub next_actions: Vec<String>,
    pub docs_ref: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorErrorV1 {
    pub schema_version: u16,
    pub code: String,
    pub problem: String,
    pub cause_class: String,
    pub retry: String,
    pub safe_next_command: String,
    pub docs_ref: String,
    pub changed_resources: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorHelpV1 {
    pub schema_version: u16,
    pub required_sections: Vec<String>,
    pub forbidden_content: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorOutputV1 {
    pub schema_version: u16,
    pub result_stream: String,
    pub diagnostics_stream: String,
    pub progress_stream: String,
    pub progress_event_fields: Vec<String>,
    pub json_documents_per_command: u16,
    pub canonical_json: bool,
    pub non_tty_color: bool,
    pub forbidden_fields: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorExitClassesV1 {
    pub schema_version: u16,
    pub classes: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentSetsV1 {
    pub schema_version: u16,
    pub demo: std::collections::BTreeMap<String, bool>,
    pub trusted: std::collections::BTreeMap<String, bool>,
    pub build_pin_source: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LicensePolicyV1 {
    pub schema_version: u16,
    pub spdx_id: String,
    pub canonical_bytes: u64,
    pub canonical_sha256: String,
    pub required_notice: String,
    pub source_classification: String,
    pub osi_approved: bool,
    pub commercial_license_status: String,
    pub external_contributions_status: String,
    pub brand_assets_status: String,
    pub trademark_registration_status: String,
}

pub const CONTRACT_PROJECTION_DIGEST: &str =
    "sha256:84fb8a9d53a55234ae3a99c8b08437afbe35a03d2f3c69c072edcd36abf37e19";
