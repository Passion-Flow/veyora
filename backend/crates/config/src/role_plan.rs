use crate::generated::{
    CAPABILITIES_FILE_SHA256, GENERATED_CAPABILITY_DEFAULT, GENERATED_CAPABILITY_SCHEMA_VERSION,
    GENERATED_SERVICE_CAPABILITIES,
};
use veyora_contracts_generated::{
    ServiceCapabilitiesV1, ServiceCapabilityMapV1, ServiceCapabilityV1, ServiceNameV1,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GeneratedServiceCapability {
    pub(crate) routes: &'static [&'static str],
    pub(crate) database_operations: &'static [&'static str],
    pub(crate) secret_files: &'static [&'static str],
    pub(crate) network_targets: &'static [&'static str],
    pub(crate) volumes: &'static [&'static str],
    pub(crate) jobs: &'static [&'static str],
    pub(crate) observability: &'static [&'static str],
    pub(crate) stdin: Option<&'static [&'static str]>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GeneratedServiceCapabilityMap {
    pub(crate) gateway: GeneratedServiceCapability,
    pub(crate) api: GeneratedServiceCapability,
    pub(crate) worker: GeneratedServiceCapability,
    pub(crate) web: GeneratedServiceCapability,
    pub(crate) sandbox: GeneratedServiceCapability,
    pub(crate) migrator: GeneratedServiceCapability,
    pub(crate) backup: GeneratedServiceCapability,
    pub(crate) restore: GeneratedServiceCapability,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoleKind {
    Api,
    Worker,
    Migrator,
    Backup,
    Restore,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceRolePlan {
    kind: RoleKind,
}

impl ServiceRolePlan {
    #[must_use]
    pub const fn kind(&self) -> RoleKind {
        self.kind
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorizationPlanErrorCode {
    VersionMismatch,
    DefaultMustDeny,
    CapabilityMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizationPlanError {
    code: AuthorizationPlanErrorCode,
}

impl AuthorizationPlanError {
    #[must_use]
    pub const fn code(&self) -> AuthorizationPlanErrorCode {
        self.code
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceAuthorizationPlans {
    roles: [ServiceRolePlan; 5],
}

impl ServiceAuthorizationPlans {
    pub fn compile(candidate: &ServiceCapabilitiesV1) -> Result<Self, AuthorizationPlanError> {
        if candidate.schema_version != GENERATED_CAPABILITY_SCHEMA_VERSION {
            return Err(error(AuthorizationPlanErrorCode::VersionMismatch));
        }
        if candidate.default != GENERATED_CAPABILITY_DEFAULT {
            return Err(error(AuthorizationPlanErrorCode::DefaultMustDeny));
        }
        if candidate != &canonical_service_capabilities() {
            return Err(error(AuthorizationPlanErrorCode::CapabilityMismatch));
        }
        Ok(Self {
            roles: [
                ServiceRolePlan {
                    kind: RoleKind::Api,
                },
                ServiceRolePlan {
                    kind: RoleKind::Worker,
                },
                ServiceRolePlan {
                    kind: RoleKind::Migrator,
                },
                ServiceRolePlan {
                    kind: RoleKind::Backup,
                },
                ServiceRolePlan {
                    kind: RoleKind::Restore,
                },
            ],
        })
    }

    #[must_use]
    pub const fn deny_by_default(&self) -> bool {
        true
    }

    #[must_use]
    pub fn roles(&self) -> &[ServiceRolePlan] {
        &self.roles
    }

    #[must_use]
    pub fn for_service(&self, service: ServiceNameV1) -> Option<&ServiceRolePlan> {
        let kind = match service {
            ServiceNameV1::Api => RoleKind::Api,
            ServiceNameV1::Worker => RoleKind::Worker,
            ServiceNameV1::Migrator => RoleKind::Migrator,
            ServiceNameV1::Backup => RoleKind::Backup,
            ServiceNameV1::Restore => RoleKind::Restore,
            ServiceNameV1::Gateway | ServiceNameV1::Web | ServiceNameV1::Sandbox => return None,
        };
        self.roles.iter().find(|role| role.kind == kind)
    }
}

#[must_use]
pub fn canonical_service_capabilities() -> ServiceCapabilitiesV1 {
    ServiceCapabilitiesV1 {
        schema_version: GENERATED_CAPABILITY_SCHEMA_VERSION,
        default: GENERATED_CAPABILITY_DEFAULT.to_owned(),
        services: ServiceCapabilityMapV1 {
            gateway: owned(GENERATED_SERVICE_CAPABILITIES.gateway),
            api: owned(GENERATED_SERVICE_CAPABILITIES.api),
            worker: owned(GENERATED_SERVICE_CAPABILITIES.worker),
            web: owned(GENERATED_SERVICE_CAPABILITIES.web),
            sandbox: owned(GENERATED_SERVICE_CAPABILITIES.sandbox),
            migrator: owned(GENERATED_SERVICE_CAPABILITIES.migrator),
            backup: owned(GENERATED_SERVICE_CAPABILITIES.backup),
            restore: owned(GENERATED_SERVICE_CAPABILITIES.restore),
        },
    }
}

#[must_use]
pub const fn canonical_capabilities_file_sha256() -> &'static str {
    CAPABILITIES_FILE_SHA256
}

fn error(code: AuthorizationPlanErrorCode) -> AuthorizationPlanError {
    AuthorizationPlanError { code }
}

fn owned(value: GeneratedServiceCapability) -> ServiceCapabilityV1 {
    ServiceCapabilityV1 {
        routes: strings(value.routes),
        database_operations: strings(value.database_operations),
        secret_files: strings(value.secret_files),
        network_targets: strings(value.network_targets),
        volumes: strings(value.volumes),
        stdin: value.stdin.map(strings),
        jobs: strings(value.jobs),
        observability: strings(value.observability),
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}
