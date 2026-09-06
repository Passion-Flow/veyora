use core::fmt;

use crate::RoleKind;
use crate::generated::CAPABILITIES_FILE_DIGEST;

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub struct UntrustedDigest([u8; 32]);

impl UntrustedDigest {
    #[must_use]
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    const fn is_zero(self) -> bool {
        let mut index = 0;
        while index < self.0.len() {
            if self.0[index] != 0 {
                return false;
            }
            index += 1;
        }
        true
    }
}

impl fmt::Debug for UntrustedDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("UntrustedDigest([OPAQUE])")
    }
}

#[must_use]
pub const fn canonical_capability_digest() -> UntrustedDigest {
    UntrustedDigest(CAPABILITIES_FILE_DIGEST)
}

#[derive(Clone, Eq, PartialEq)]
pub struct UntrustedBootstrapIdentity {
    plan: UntrustedDigest,
    destination: UntrustedDigest,
    configuration: UntrustedDigest,
    capabilities: UntrustedDigest,
    contract: UntrustedDigest,
    guard_epoch: u64,
}

impl UntrustedBootstrapIdentity {
    #[must_use]
    pub const fn new(
        plan: UntrustedDigest,
        destination: UntrustedDigest,
        configuration: UntrustedDigest,
        contract: UntrustedDigest,
        guard_epoch: u64,
    ) -> Self {
        Self {
            plan,
            destination,
            configuration,
            capabilities: canonical_capability_digest(),
            contract,
            guard_epoch,
        }
    }

    fn is_complete(&self) -> bool {
        !self.plan.is_zero()
            && !self.destination.is_zero()
            && !self.configuration.is_zero()
            && !self.capabilities.is_zero()
            && !self.contract.is_zero()
            && self.guard_epoch > 0
    }
}

impl fmt::Debug for UntrustedBootstrapIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("UntrustedBootstrapIdentity([OPAQUE])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UntrustedDestinationState {
    Absent,
    ExactCompleted,
    Partial,
    Unexpected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedFeature {
    DatabaseCreation,
    SchemaCreation,
    RoleCreation,
    DefaultPrivileges,
    OwnershipInspection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UntrustedManagedFeatureDiagnostics {
    database_creation: bool,
    schema_creation: bool,
    role_creation: bool,
    default_privileges: bool,
    ownership_inspection: bool,
}

impl UntrustedManagedFeatureDiagnostics {
    #[must_use]
    pub const fn all_reported_available() -> Self {
        Self {
            database_creation: true,
            schema_creation: true,
            role_creation: true,
            default_privileges: true,
            ownership_inspection: true,
        }
    }

    pub fn report_unavailable(&mut self, feature: ManagedFeature) {
        match feature {
            ManagedFeature::DatabaseCreation => self.database_creation = false,
            ManagedFeature::SchemaCreation => self.schema_creation = false,
            ManagedFeature::RoleCreation => self.role_creation = false,
            ManagedFeature::DefaultPrivileges => self.default_privileges = false,
            ManagedFeature::OwnershipInspection => self.ownership_inspection = false,
        }
    }

    fn first_unavailable(&self) -> Option<ManagedFeature> {
        [
            (ManagedFeature::DatabaseCreation, self.database_creation),
            (ManagedFeature::SchemaCreation, self.schema_creation),
            (ManagedFeature::RoleCreation, self.role_creation),
            (ManagedFeature::DefaultPrivileges, self.default_privileges),
            (
                ManagedFeature::OwnershipInspection,
                self.ownership_inspection,
            ),
        ]
        .into_iter()
        .find_map(|(feature, available)| (!available).then_some(feature))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DriftField {
    Owner,
    RoleAttributes,
    Grants,
    SearchPath,
    DefaultPrivileges,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UntrustedDriftDiagnostics {
    owner: bool,
    role_attributes: bool,
    grants: bool,
    search_path: bool,
    default_privileges: bool,
}

impl UntrustedDriftDiagnostics {
    #[must_use]
    pub const fn reported_no_drift() -> Self {
        Self {
            owner: false,
            role_attributes: false,
            grants: false,
            search_path: false,
            default_privileges: false,
        }
    }

    pub fn report_drift(&mut self, field: DriftField) {
        match field {
            DriftField::Owner => self.owner = true,
            DriftField::RoleAttributes => self.role_attributes = true,
            DriftField::Grants => self.grants = true,
            DriftField::SearchPath => self.search_path = true,
            DriftField::DefaultPrivileges => self.default_privileges = true,
        }
    }

    fn first_reported_drift(&self) -> Option<DriftField> {
        [
            (DriftField::Owner, self.owner),
            (DriftField::RoleAttributes, self.role_attributes),
            (DriftField::Grants, self.grants),
            (DriftField::SearchPath, self.search_path),
            (DriftField::DefaultPrivileges, self.default_privileges),
        ]
        .into_iter()
        .find_map(|(field, drifted)| drifted.then_some(field))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UntrustedBootstrapObservation {
    plan: UntrustedDigest,
    destination: UntrustedDigest,
    configuration: UntrustedDigest,
    capabilities: UntrustedDigest,
    contract: UntrustedDigest,
    guard_epoch: u64,
    features: UntrustedManagedFeatureDiagnostics,
    destination_state: UntrustedDestinationState,
    drift: UntrustedDriftDiagnostics,
}

impl UntrustedBootstrapObservation {
    // Every value is a distinct, protocol-bound observation; grouping them
    // would obscure the exact evidence tuple this constructor validates.
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub const fn new(
        plan: UntrustedDigest,
        destination: UntrustedDigest,
        configuration: UntrustedDigest,
        capabilities: UntrustedDigest,
        contract: UntrustedDigest,
        guard_epoch: u64,
        features: UntrustedManagedFeatureDiagnostics,
        destination_state: UntrustedDestinationState,
        drift: UntrustedDriftDiagnostics,
    ) -> Self {
        Self {
            plan,
            destination,
            configuration,
            capabilities,
            contract,
            guard_epoch,
            features,
            destination_state,
            drift,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApplyCandidate {
    identity: UntrustedBootstrapIdentity,
    actions: Vec<BootstrapAction>,
}

impl ApplyCandidate {
    #[must_use]
    pub fn actions(&self) -> &[BootstrapAction] {
        &self.actions
    }

    pub fn role_actions(&self) -> impl Iterator<Item = RoleKind> + '_ {
        self.actions.iter().filter_map(|action| match action {
            BootstrapAction::CreateRole(role) => Some(*role),
            _ => None,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifyOnlyCandidate {
    identity: UntrustedBootstrapIdentity,
    actions: Vec<BootstrapAction>,
}

impl VerifyOnlyCandidate {
    #[must_use]
    pub fn actions(&self) -> &[BootstrapAction] {
        &self.actions
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UntrustedExecutionAssessment {
    ApplyCandidate(ApplyCandidate),
    VerifyOnlyCandidate(VerifyOnlyCandidate),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BootstrapAction {
    RequireExclusiveGuard,
    InspectDestination,
    CreateDatabase,
    CreateApplicationSchema,
    CreateRole(RoleKind),
    EnforceDenyByDefault,
    VerifyOwner,
    VerifyRoleAttributes,
    VerifyGrants,
    VerifySearchPath,
    VerifyDefaultPrivileges,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BootstrapIdentityField {
    Plan,
    Destination,
    Configuration,
    Capabilities,
    Contract,
    GuardEpoch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BootstrapErrorCode {
    IdentityRequired,
    ObservationIdentityMismatch,
    ManagedFeatureUnavailable,
    PreExistingStateMismatch,
    DiagnosticDrift,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BootstrapError {
    code: BootstrapErrorCode,
    identity_field: Option<BootstrapIdentityField>,
    feature: Option<ManagedFeature>,
    drift: Option<DriftField>,
}

impl BootstrapError {
    #[must_use]
    pub const fn code(&self) -> BootstrapErrorCode {
        self.code
    }

    #[must_use]
    pub const fn identity_field(&self) -> Option<BootstrapIdentityField> {
        self.identity_field
    }

    #[must_use]
    pub const fn feature(&self) -> Option<ManagedFeature> {
        self.feature
    }

    #[must_use]
    pub const fn drift(&self) -> Option<DriftField> {
        self.drift
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ExternalDatabaseBootstrapPlan {
    identity: UntrustedBootstrapIdentity,
}

impl ExternalDatabaseBootstrapPlan {
    pub fn draft(identity: UntrustedBootstrapIdentity) -> Result<Self, BootstrapError> {
        if !identity.is_complete() {
            return Err(error(BootstrapErrorCode::IdentityRequired));
        }
        Ok(Self { identity })
    }

    pub fn assess_untrusted(
        &self,
        observed: &UntrustedBootstrapObservation,
    ) -> Result<UntrustedExecutionAssessment, BootstrapError> {
        if let Some(field) = identity_mismatch(&self.identity, observed) {
            return Err(BootstrapError {
                code: BootstrapErrorCode::ObservationIdentityMismatch,
                identity_field: Some(field),
                feature: None,
                drift: None,
            });
        }
        if let Some(feature) = observed.features.first_unavailable() {
            return Err(BootstrapError {
                code: BootstrapErrorCode::ManagedFeatureUnavailable,
                identity_field: None,
                feature: Some(feature),
                drift: None,
            });
        }
        if let Some(field) = observed.drift.first_reported_drift() {
            return Err(BootstrapError {
                code: BootstrapErrorCode::DiagnosticDrift,
                identity_field: None,
                feature: None,
                drift: Some(field),
            });
        }
        match observed.destination_state {
            UntrustedDestinationState::Absent => Ok(UntrustedExecutionAssessment::ApplyCandidate(
                ApplyCandidate {
                    identity: self.identity.clone(),
                    actions: apply_actions(),
                },
            )),
            UntrustedDestinationState::ExactCompleted => Ok(
                UntrustedExecutionAssessment::VerifyOnlyCandidate(VerifyOnlyCandidate {
                    identity: self.identity.clone(),
                    actions: verify_only_actions(),
                }),
            ),
            UntrustedDestinationState::Partial | UntrustedDestinationState::Unexpected => {
                Err(error(BootstrapErrorCode::PreExistingStateMismatch))
            }
        }
    }
}

impl fmt::Debug for ExternalDatabaseBootstrapPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExternalDatabaseBootstrapPlan")
            .field("identity", &"[OPAQUE]")
            .field("evidence", &"untrusted-diagnostics-only")
            .finish()
    }
}

fn identity_mismatch(
    expected: &UntrustedBootstrapIdentity,
    observed: &UntrustedBootstrapObservation,
) -> Option<BootstrapIdentityField> {
    [
        (BootstrapIdentityField::Plan, expected.plan != observed.plan),
        (
            BootstrapIdentityField::Destination,
            expected.destination != observed.destination,
        ),
        (
            BootstrapIdentityField::Configuration,
            expected.configuration != observed.configuration,
        ),
        (
            BootstrapIdentityField::Capabilities,
            expected.capabilities != observed.capabilities,
        ),
        (
            BootstrapIdentityField::Contract,
            expected.contract != observed.contract,
        ),
        (
            BootstrapIdentityField::GuardEpoch,
            expected.guard_epoch != observed.guard_epoch,
        ),
    ]
    .into_iter()
    .find_map(|(field, differs)| differs.then_some(field))
}

fn error(code: BootstrapErrorCode) -> BootstrapError {
    BootstrapError {
        code,
        identity_field: None,
        feature: None,
        drift: None,
    }
}

fn apply_actions() -> Vec<BootstrapAction> {
    vec![
        BootstrapAction::RequireExclusiveGuard,
        BootstrapAction::InspectDestination,
        BootstrapAction::CreateDatabase,
        BootstrapAction::CreateApplicationSchema,
        BootstrapAction::CreateRole(RoleKind::Api),
        BootstrapAction::CreateRole(RoleKind::Worker),
        BootstrapAction::CreateRole(RoleKind::Migrator),
        BootstrapAction::CreateRole(RoleKind::Backup),
        BootstrapAction::CreateRole(RoleKind::Restore),
        BootstrapAction::EnforceDenyByDefault,
        BootstrapAction::VerifyOwner,
        BootstrapAction::VerifyRoleAttributes,
        BootstrapAction::VerifyGrants,
        BootstrapAction::VerifySearchPath,
        BootstrapAction::VerifyDefaultPrivileges,
    ]
}

fn verify_only_actions() -> Vec<BootstrapAction> {
    vec![
        BootstrapAction::RequireExclusiveGuard,
        BootstrapAction::InspectDestination,
        BootstrapAction::VerifyOwner,
        BootstrapAction::VerifyRoleAttributes,
        BootstrapAction::VerifyGrants,
        BootstrapAction::VerifySearchPath,
        BootstrapAction::VerifyDefaultPrivileges,
    ]
}
