//! Dependency-free, in-memory configuration and operator-plan abstractions.
//!
//! This crate deliberately performs no filesystem, network, database, or cryptographic work.

#![forbid(unsafe_code)]

mod bootstrap_plan;
mod generated;
mod resolved;
mod role_plan;
mod value;

pub use bootstrap_plan::*;
pub use resolved::*;
pub use role_plan::*;
pub use value::*;
