use backend_config::{
    BootstrapAction, BootstrapErrorCode, BootstrapIdentityField, DriftField,
    ExternalDatabaseBootstrapPlan, ManagedFeature, RoleKind, UntrustedBootstrapIdentity,
    UntrustedBootstrapObservation, UntrustedDestinationState, UntrustedDigest,
    UntrustedDriftDiagnostics, UntrustedExecutionAssessment, UntrustedManagedFeatureDiagnostics,
    canonical_capability_digest,
};

fn digest(byte: u8) -> UntrustedDigest {
    UntrustedDigest::new([byte; 32])
}

fn identity() -> UntrustedBootstrapIdentity {
    UntrustedBootstrapIdentity::new(digest(1), digest(2), digest(3), digest(4), 7)
}

fn observation(state: UntrustedDestinationState) -> UntrustedBootstrapObservation {
    observation_for(1, state)
}

fn observation_for(plan: u8, state: UntrustedDestinationState) -> UntrustedBootstrapObservation {
    UntrustedBootstrapObservation::new(
        digest(plan),
        digest(2),
        digest(3),
        canonical_capability_digest(),
        digest(4),
        7,
        UntrustedManagedFeatureDiagnostics::all_reported_available(),
        state,
        UntrustedDriftDiagnostics::reported_no_drift(),
    )
}

#[test]
fn draft_is_deterministic_and_retains_all_identity_dimensions() {
    let first = ExternalDatabaseBootstrapPlan::draft(identity()).expect("abstract plan draft");
    let second = ExternalDatabaseBootstrapPlan::draft(identity()).expect("same plan draft");
    assert_eq!(first, second);
    let assessment = first
        .assess_untrusted(&observation(UntrustedDestinationState::Absent))
        .expect("matching untrusted diagnostic set");
    let UntrustedExecutionAssessment::ApplyCandidate(candidate) = assessment else {
        panic!("absent destination must return an apply candidate");
    };
    assert_eq!(
        candidate.role_actions().collect::<Vec<_>>(),
        vec![
            RoleKind::Api,
            RoleKind::Worker,
            RoleKind::Migrator,
            RoleKind::Backup,
            RoleKind::Restore,
        ]
    );
    assert!(
        candidate
            .actions()
            .contains(&BootstrapAction::CreateDatabase)
    );
    assert!(
        candidate
            .actions()
            .contains(&BootstrapAction::CreateApplicationSchema)
    );
    assert!(
        candidate
            .actions()
            .contains(&BootstrapAction::EnforceDenyByDefault)
    );

    let debug = format!("{first:?}");
    assert!(!debug.contains(&"01".repeat(32)));
    assert!(debug.contains("[OPAQUE]"));
}

#[test]
fn cross_plan_destination_config_capability_contract_and_epoch_observations_reject() {
    let plan = ExternalDatabaseBootstrapPlan::draft(identity()).expect("abstract plan draft");
    let hostile: [(BootstrapIdentityField, UntrustedBootstrapObservation); 6] = [
        (
            BootstrapIdentityField::Plan,
            UntrustedBootstrapObservation::new(
                digest(9),
                digest(2),
                digest(3),
                canonical_capability_digest(),
                digest(4),
                7,
                UntrustedManagedFeatureDiagnostics::all_reported_available(),
                UntrustedDestinationState::Absent,
                UntrustedDriftDiagnostics::reported_no_drift(),
            ),
        ),
        (
            BootstrapIdentityField::Destination,
            UntrustedBootstrapObservation::new(
                digest(1),
                digest(9),
                digest(3),
                canonical_capability_digest(),
                digest(4),
                7,
                UntrustedManagedFeatureDiagnostics::all_reported_available(),
                UntrustedDestinationState::Absent,
                UntrustedDriftDiagnostics::reported_no_drift(),
            ),
        ),
        (
            BootstrapIdentityField::Configuration,
            UntrustedBootstrapObservation::new(
                digest(1),
                digest(2),
                digest(9),
                canonical_capability_digest(),
                digest(4),
                7,
                UntrustedManagedFeatureDiagnostics::all_reported_available(),
                UntrustedDestinationState::Absent,
                UntrustedDriftDiagnostics::reported_no_drift(),
            ),
        ),
        (
            BootstrapIdentityField::Capabilities,
            UntrustedBootstrapObservation::new(
                digest(1),
                digest(2),
                digest(3),
                digest(9),
                digest(4),
                7,
                UntrustedManagedFeatureDiagnostics::all_reported_available(),
                UntrustedDestinationState::Absent,
                UntrustedDriftDiagnostics::reported_no_drift(),
            ),
        ),
        (
            BootstrapIdentityField::Contract,
            UntrustedBootstrapObservation::new(
                digest(1),
                digest(2),
                digest(3),
                canonical_capability_digest(),
                digest(9),
                7,
                UntrustedManagedFeatureDiagnostics::all_reported_available(),
                UntrustedDestinationState::Absent,
                UntrustedDriftDiagnostics::reported_no_drift(),
            ),
        ),
        (
            BootstrapIdentityField::GuardEpoch,
            UntrustedBootstrapObservation::new(
                digest(1),
                digest(2),
                digest(3),
                canonical_capability_digest(),
                digest(4),
                6,
                UntrustedManagedFeatureDiagnostics::all_reported_available(),
                UntrustedDestinationState::Absent,
                UntrustedDriftDiagnostics::reported_no_drift(),
            ),
        ),
    ];
    for (field, observed) in hostile {
        let error = plan
            .assess_untrusted(&observed)
            .expect_err("cross-identity observation must fail closed");
        assert_eq!(
            error.code(),
            BootstrapErrorCode::ObservationIdentityMismatch
        );
        assert_eq!(error.identity_field(), Some(field));
    }
}

#[test]
fn exact_completed_is_only_an_untrusted_candidate_and_other_preexisting_state_refuses() {
    let plan = ExternalDatabaseBootstrapPlan::draft(identity()).expect("abstract plan draft");
    let exact = plan
        .assess_untrusted(&observation(UntrustedDestinationState::ExactCompleted))
        .expect("matching exact-completed diagnostics");
    let UntrustedExecutionAssessment::VerifyOnlyCandidate(candidate) = exact else {
        panic!("completed destination must return a verify-only candidate");
    };
    assert_eq!(
        candidate.actions(),
        [
            BootstrapAction::RequireExclusiveGuard,
            BootstrapAction::InspectDestination,
            BootstrapAction::VerifyOwner,
            BootstrapAction::VerifyRoleAttributes,
            BootstrapAction::VerifyGrants,
            BootstrapAction::VerifySearchPath,
            BootstrapAction::VerifyDefaultPrivileges,
        ]
    );
    assert!(!candidate.actions().iter().any(|action| matches!(
        action,
        BootstrapAction::CreateDatabase
            | BootstrapAction::CreateApplicationSchema
            | BootstrapAction::CreateRole(_)
            | BootstrapAction::EnforceDenyByDefault
    )));

    for state in [
        UntrustedDestinationState::Partial,
        UntrustedDestinationState::Unexpected,
    ] {
        let error = plan
            .assess_untrusted(&observation(state))
            .expect_err("non-exact pre-existing diagnostics must fail closed");
        assert_eq!(error.code(), BootstrapErrorCode::PreExistingStateMismatch);
    }
}

#[test]
fn candidates_remain_bound_to_the_plan_identity_that_produced_them() {
    let first_plan = ExternalDatabaseBootstrapPlan::draft(identity()).expect("first plan draft");
    let second_plan = ExternalDatabaseBootstrapPlan::draft(UntrustedBootstrapIdentity::new(
        digest(9),
        digest(2),
        digest(3),
        digest(4),
        7,
    ))
    .expect("second plan draft");
    let first = first_plan
        .assess_untrusted(&observation_for(1, UntrustedDestinationState::Absent))
        .expect("first matching observation");
    let second = second_plan
        .assess_untrusted(&observation_for(9, UntrustedDestinationState::Absent))
        .expect("second matching observation");
    assert_ne!(
        first, second,
        "candidate identity must not collapse to its action set"
    );

    let error = first_plan
        .assess_untrusted(&observation_for(9, UntrustedDestinationState::Absent))
        .expect_err("a second plan observation must not produce a first-plan candidate");
    assert_eq!(
        error.code(),
        BootstrapErrorCode::ObservationIdentityMismatch
    );
    assert_eq!(error.identity_field(), Some(BootstrapIdentityField::Plan));
}

#[test]
fn zero_identity_or_epoch_is_rejected_before_drafting() {
    for identity in [
        UntrustedBootstrapIdentity::new(digest(0), digest(2), digest(3), digest(4), 7),
        UntrustedBootstrapIdentity::new(digest(1), digest(0), digest(3), digest(4), 7),
        UntrustedBootstrapIdentity::new(digest(1), digest(2), digest(0), digest(4), 7),
        UntrustedBootstrapIdentity::new(digest(1), digest(2), digest(3), digest(0), 7),
        UntrustedBootstrapIdentity::new(digest(1), digest(2), digest(3), digest(4), 0),
    ] {
        let error = ExternalDatabaseBootstrapPlan::draft(identity)
            .expect_err("zero identity component must fail closed");
        assert_eq!(error.code(), BootstrapErrorCode::IdentityRequired);
    }
}

#[test]
fn missing_managed_feature_is_only_an_explicit_untrusted_diagnostic() {
    let plan = ExternalDatabaseBootstrapPlan::draft(identity()).expect("abstract plan draft");
    for feature in [
        ManagedFeature::DatabaseCreation,
        ManagedFeature::SchemaCreation,
        ManagedFeature::RoleCreation,
        ManagedFeature::DefaultPrivileges,
        ManagedFeature::OwnershipInspection,
    ] {
        let mut diagnostics = UntrustedManagedFeatureDiagnostics::all_reported_available();
        diagnostics.report_unavailable(feature);
        let observed = UntrustedBootstrapObservation::new(
            digest(1),
            digest(2),
            digest(3),
            canonical_capability_digest(),
            digest(4),
            7,
            diagnostics,
            UntrustedDestinationState::Absent,
            UntrustedDriftDiagnostics::reported_no_drift(),
        );
        let error = plan
            .assess_untrusted(&observed)
            .expect_err("reported unsupported feature must not fall back");
        assert_eq!(error.code(), BootstrapErrorCode::ManagedFeatureUnavailable);
        assert_eq!(error.feature(), Some(feature));
    }
}

#[test]
fn every_reported_drift_class_rejects_without_claiming_verification() {
    let plan = ExternalDatabaseBootstrapPlan::draft(identity()).expect("abstract plan draft");
    for field in [
        DriftField::Owner,
        DriftField::Grants,
        DriftField::SearchPath,
        DriftField::DefaultPrivileges,
        DriftField::RoleAttributes,
    ] {
        let mut diagnostics = UntrustedDriftDiagnostics::reported_no_drift();
        diagnostics.report_drift(field);
        let observed = UntrustedBootstrapObservation::new(
            digest(1),
            digest(2),
            digest(3),
            canonical_capability_digest(),
            digest(4),
            7,
            UntrustedManagedFeatureDiagnostics::all_reported_available(),
            UntrustedDestinationState::Absent,
            diagnostics,
        );
        let error = plan
            .assess_untrusted(&observed)
            .expect_err("reported drift must fail closed");
        assert_eq!(error.code(), BootstrapErrorCode::DiagnosticDrift);
        assert_eq!(error.drift(), Some(field));
    }
}
