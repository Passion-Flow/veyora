use backend_config::{
    AuthorizationPlanErrorCode, RoleKind, ServiceAuthorizationPlans,
    canonical_capabilities_file_sha256, canonical_service_capabilities,
};
use veyora_contracts_generated::{ServiceCapabilitiesV1, ServiceNameV1};

#[test]
fn generated_canonical_matrix_compiles_to_five_deny_by_default_roles() {
    assert_eq!(
        canonical_capabilities_file_sha256(),
        "sha256:b61f9d02a98a261b65a0c5d2efa84e7611816904a188206d58ad2f4889c219c5"
    );
    let plans = ServiceAuthorizationPlans::compile(&canonical_service_capabilities())
        .expect("generated canonical matrix");
    assert!(plans.deny_by_default());
    assert_eq!(
        plans
            .roles()
            .iter()
            .map(|role| role.kind())
            .collect::<Vec<_>>(),
        vec![
            RoleKind::Api,
            RoleKind::Worker,
            RoleKind::Migrator,
            RoleKind::Backup,
            RoleKind::Restore,
        ]
    );
    assert!(plans.for_service(ServiceNameV1::Sandbox).is_none());
    assert!(plans.for_service(ServiceNameV1::Gateway).is_none());
    assert!(plans.for_service(ServiceNameV1::Web).is_none());
}

#[test]
fn rejects_allow_by_default_and_schema_drift() {
    let mut allow = canonical_service_capabilities();
    allow.default = "allow".into();
    let error = ServiceAuthorizationPlans::compile(&allow).expect_err("allow default");
    assert_eq!(error.code(), AuthorizationPlanErrorCode::DefaultMustDeny);

    let mut wrong_version = canonical_service_capabilities();
    wrong_version.schema_version = 2;
    let error = ServiceAuthorizationPlans::compile(&wrong_version).expect_err("wrong version");
    assert_eq!(error.code(), AuthorizationPlanErrorCode::VersionMismatch);
}

#[test]
fn rejects_one_forbidden_capability_mutation_per_database_role() {
    let mutations: [fn(&mut ServiceCapabilitiesV1); 5] = [
        |matrix| matrix.services.api.routes.push("hostile-route".into()),
        |matrix| {
            matrix
                .services
                .worker
                .database_operations
                .push("hostile-table".into())
        },
        |matrix| {
            matrix
                .services
                .migrator
                .secret_files
                .push("hostile-secret".into())
        },
        |matrix| {
            matrix
                .services
                .backup
                .network_targets
                .push("hostile-network".into())
        },
        |matrix| {
            matrix
                .services
                .restore
                .volumes
                .push("hostile-volume".into())
        },
    ];
    for mutate in mutations {
        let mut hostile = canonical_service_capabilities();
        mutate(&mut hostile);
        let error = ServiceAuthorizationPlans::compile(&hostile)
            .expect_err("forbidden capability mutation must fail closed");
        assert_eq!(error.code(), AuthorizationPlanErrorCode::CapabilityMismatch);
    }
}

#[test]
fn rejects_sandbox_authority_mutations() {
    let mutations: [fn(&mut ServiceCapabilitiesV1); 6] = [
        |matrix| {
            matrix
                .services
                .sandbox
                .database_operations
                .push("hostile-db".into())
        },
        |matrix| {
            matrix
                .services
                .sandbox
                .secret_files
                .push("hostile-key".into())
        },
        |matrix| {
            matrix
                .services
                .sandbox
                .network_targets
                .push("hostile-network".into())
        },
        |matrix| {
            matrix
                .services
                .sandbox
                .volumes
                .push("hostile-volume".into())
        },
        |matrix| matrix.services.sandbox.jobs.push("hostile-job".into()),
        |matrix| matrix.services.sandbox.routes.push("hostile-route".into()),
    ];
    for mutate in mutations {
        let mut hostile = canonical_service_capabilities();
        mutate(&mut hostile);
        let error = ServiceAuthorizationPlans::compile(&hostile)
            .expect_err("sandbox authority must fail closed");
        assert_eq!(error.code(), AuthorizationPlanErrorCode::CapabilityMismatch);
    }
}
