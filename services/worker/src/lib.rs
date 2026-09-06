//! Veyora worker support library: the Trash retention policy (DATA-008).
//!
//! The policy is deliberately tiny and total: `from_env` parses the
//! operator knob (`VEYORA_TRASH_RETENTION_DAYS`, default 30 per PRD
//! DEC-009/ITEM-009; `0` disables purging entirely), and
//! [`retention_cutoff`] turns it into the epoch-second cutoff the storage
//! adapters purge against. All pure functions are unit-tested so the
//! delete-decision math can never drift silently.

/// Operator-configured Trash retention (DATA-008 / ITEM-009).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetentionPolicy {
    /// Purge tombstones older than this many whole days.
    Days(u64),
    /// Keep tombstones forever; the worker only monitors.
    Disabled,
}

impl RetentionPolicy {
    /// Parse `VEYORA_TRASH_RETENTION_DAYS`. Absent means the PRD default
    /// (30 days); `0` explicitly disables purging. Malformed values are
    /// returned as an error message so the worker fails fast instead of
    /// silently deleting with an unintended window.
    pub fn from_env(raw: Option<&str>) -> Result<Self, String> {
        match raw {
            None => Ok(Self::Days(30)),
            Some(text) if text.trim().is_empty() => Ok(Self::Days(30)),
            Some(text) => match text.trim().parse::<u64>() {
                Ok(0) => Ok(Self::Disabled),
                Ok(days) => Ok(Self::Days(days)),
                Err(_) => Err(format!(
                    "VEYORA_TRASH_RETENTION_DAYS must be a non-negative integer (got {text:?})"
                )),
            },
        }
    }

    /// The epoch-second cutoff a tombstone stamp must not exceed to be
    /// purged at `now_epoch`. `None` when purging is disabled. The window
    /// saturates at zero instead of underflowing for clocks set before the
    /// retention window (RELIA-005: clock oddity never deletes early).
    pub fn cutoff(&self, now_epoch: u64) -> Option<u64> {
        match self {
            Self::Disabled => None,
            Self::Days(days) => Some(now_epoch.saturating_sub(days.saturating_mul(86_400))),
        }
    }
}

/// Run one retention sweep across every vault scope in the store, purging
/// tombstones at or before the policy cutoff. Returns the total purged
/// count (0 when disabled or nothing is eligible). One implementation of
/// "purge consistently": the worker only chooses the cutoff, the store
/// owns the delete semantics.
pub fn run_retention(
    store: &dyn backend_persistence::OpaqueStore,
    vaults: &[String],
    policy: &RetentionPolicy,
    now_epoch: u64,
) -> Result<u64, backend_persistence::StoreError> {
    let Some(cutoff) = policy.cutoff(now_epoch) else {
        return Ok(0);
    };
    let mut purged = 0;
    for vault in vaults {
        purged += store.purge_tombstoned_before(vault, cutoff)?;
    }
    Ok(purged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_retention_is_thirty_days() {
        assert_eq!(
            RetentionPolicy::from_env(None),
            Ok(RetentionPolicy::Days(30))
        );
        assert_eq!(
            RetentionPolicy::from_env(Some("")),
            Ok(RetentionPolicy::Days(30))
        );
    }

    #[test]
    fn zero_disables_and_values_parse() {
        assert_eq!(
            RetentionPolicy::from_env(Some("0")),
            Ok(RetentionPolicy::Disabled)
        );
        assert_eq!(
            RetentionPolicy::from_env(Some(" 7 ")),
            Ok(RetentionPolicy::Days(7))
        );
        assert!(RetentionPolicy::from_env(Some("soon")).is_err());
        assert!(RetentionPolicy::from_env(Some("-1")).is_err());
    }

    #[test]
    fn cutoff_math_saturates_instead_of_underflowing() {
        let now = 1_700_000_000;
        assert_eq!(
            RetentionPolicy::Days(30).cutoff(now),
            Some(now - 30 * 86_400)
        );
        // A clock before the window saturates at zero: nothing is older
        // than the epoch, so an early clock deletes nothing extra.
        assert_eq!(RetentionPolicy::Days(30).cutoff(100), Some(0));
        assert_eq!(RetentionPolicy::Disabled.cutoff(now), None);
    }
}
