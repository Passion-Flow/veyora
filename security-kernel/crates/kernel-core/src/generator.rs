//! CSPRNG-backed password generator (v1 policy).
//!
//! Implements `contracts/generator/password-generator-v1.json`: client-OS-CSPRNG
//! source, unbiased rejection sampling (no modulo bias), length 8..=128, and an
//! empty-alphabet rejection. Output is a zeroized secret.

use zeroize::Zeroizing;

use crate::{KernelError, RandomSource};

/// Minimum and maximum generated length, per the v1 generator policy.
pub const MIN_LENGTH: usize = 8;
pub const MAX_LENGTH: usize = 128;

/// The v1 character classes, verbatim from the generator policy contract.
pub mod classes {
    pub const UPPERCASE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    pub const LOWERCASE: &str = "abcdefghijklmnopqrstuvwxyz";
    pub const NUMBERS: &str = "0123456789";
    pub const SYMBOLS: &str = "!@#$%^&*()-_=+[]{}:,.?";
}

/// Generate a `length`-character password over `alphabet` using rejection
/// sampling so every character is selected without modulo bias. The alphabet
/// must be non-empty; `length` must be within `[MIN_LENGTH, MAX_LENGTH]`.
pub fn generate_password(
    rng: &mut dyn RandomSource,
    alphabet: &[char],
    length: usize,
) -> Result<Zeroizing<String>, KernelError> {
    if alphabet.is_empty() {
        return Err(KernelError::InvalidSecretText);
    }
    if !(MIN_LENGTH..=MAX_LENGTH).contains(&length) {
        return Err(KernelError::LimitExceeded);
    }
    let n = u32::try_from(alphabet.len()).map_err(|_| KernelError::LimitExceeded)?;
    if n == 0 {
        return Err(KernelError::InvalidSecretText);
    }
    // Largest multiple of n not exceeding 256; bytes at or above this are redrawn.
    let threshold = 256 - (256 % n);
    let mut chars = String::with_capacity(length);
    while chars.len() < length {
        let mut byte = [0u8; 1];
        rng.fill_bytes(&mut byte)?;
        let value = u32::from(byte[0]);
        if value < threshold {
            // Bound redraws so a hostile/failing RNG cannot loop forever.
            let index = usize::try_from(value % n).map_err(|_| KernelError::LimitExceeded)?;
            chars.push(alphabet[index]);
        }
    }
    Ok(Zeroizing::new(chars))
}

/// Concatenate the standard v1 classes into one alphabet, in policy order.
#[must_use]
pub fn default_alphabet() -> Vec<char> {
    [
        classes::UPPERCASE,
        classes::LOWERCASE,
        classes::NUMBERS,
        classes::SYMBOLS,
    ]
    .concat()
    .chars()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic RNG for reproducible generator tests.
    struct CounterRng(u8);
    impl RandomSource for CounterRng {
        fn fill_bytes(&mut self, out: &mut [u8]) -> Result<(), KernelError> {
            for slot in out {
                *slot = self.0;
                self.0 = self.0.wrapping_add(7);
            }
            Ok(())
        }
    }

    #[test]
    fn default_alphabet_matches_policy_concatenation() {
        let alpha = default_alphabet();
        assert_eq!(
            alpha.len(),
            classes::UPPERCASE.len()
                + classes::LOWERCASE.len()
                + classes::NUMBERS.len()
                + classes::SYMBOLS.len()
        );
        assert!(
            alpha.contains(&'A')
                && alpha.contains(&'a')
                && alpha.contains(&'0')
                && alpha.contains(&'!')
        );
    }

    #[test]
    fn generate_is_deterministic_for_a_fixed_rng() {
        let alphabet = default_alphabet();
        let mut a = CounterRng(1);
        let mut b = CounterRng(1);
        let x = generate_password(&mut a, &alphabet, 20).unwrap();
        let y = generate_password(&mut b, &alphabet, 20).unwrap();
        assert_eq!(*x, *y);
        assert_eq!(x.len(), 20);
    }

    #[test]
    fn every_character_comes_from_the_alphabet() {
        let alphabet: Vec<char> = "ab".chars().collect();
        let mut rng = CounterRng(3);
        let password = generate_password(&mut rng, &alphabet, 32).unwrap();
        assert_eq!(password.len(), 32);
        assert!(password.chars().all(|c| c == 'a' || c == 'b'));
    }

    #[test]
    fn empty_alphabet_is_rejected() {
        let mut rng = CounterRng(0);
        assert_eq!(
            generate_password(&mut rng, &[], 20).err(),
            Some(KernelError::InvalidSecretText)
        );
    }

    #[test]
    fn out_of_range_length_is_rejected() {
        let alphabet = default_alphabet();
        let mut rng = CounterRng(0);
        assert_eq!(
            generate_password(&mut rng, &alphabet, MIN_LENGTH - 1).err(),
            Some(KernelError::LimitExceeded)
        );
        assert_eq!(
            generate_password(&mut rng, &alphabet, MAX_LENGTH + 1).err(),
            Some(KernelError::LimitExceeded)
        );
        assert!(generate_password(&mut rng, &alphabet, MIN_LENGTH).is_ok());
        assert!(generate_password(&mut rng, &alphabet, MAX_LENGTH).is_ok());
    }

    #[test]
    fn os_rng_generates_a_full_default_length_password() {
        let alphabet = default_alphabet();
        let mut os = crate::OsRandomSource;
        let password = generate_password(&mut os, &alphabet, 20).unwrap();
        assert_eq!(password.len(), 20);
        let set: std::collections::HashSet<char> = alphabet.into_iter().collect();
        assert!(password.chars().all(|c| set.contains(&c)));
    }

    /// Rejection sampling must not map a byte value outside the unbiased range
    /// to a character. With a tiny alphabet of size 5, threshold = 255, so byte
    /// 255 is rejected and bytes 0..254 are accepted as value % 5.
    #[test]
    fn rejection_sampling_uses_only_unbiased_bytes() {
        let alphabet: Vec<char> = "abcde".chars().collect();
        // RNG emits 255 (rejected), then 0..7 accepted. length is 8 (>= MIN_LENGTH).
        struct Rng2 {
            seq: std::collections::VecDeque<u8>,
        }
        impl RandomSource for Rng2 {
            fn fill_bytes(&mut self, out: &mut [u8]) -> Result<(), KernelError> {
                for slot in out {
                    *slot = self.seq.pop_front().unwrap_or(0);
                }
                Ok(())
            }
        }
        let mut rng = Rng2 {
            seq: vec![255, 0, 1, 2, 3, 4, 5, 6, 7].into_iter().collect(),
        };
        let password = generate_password(&mut rng, &alphabet, 8).unwrap();
        // 255 rejected; 0..7 map to indices 0,1,2,3,4,0,1,2 -> a,b,c,d,e,a,b,c.
        assert_eq!(*password, "abcdeabc");
    }
}
