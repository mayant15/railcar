// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::{bail, Result};

use std::collections::BTreeMap;

use libafl_bolts::rands::Rand;

/// Maximum random number generated for functions that need number. Keep this low because this
/// could be an array length
const MAX_RANDOM_NUMBER: f64 = 1000.0;
const MAX_RANDOM_SIZE: usize = 10;

/// The rate at which we generate integers when generating numbers. This is useful as integers are
/// more likely to be valid inputs to things like array lengths.
const INTEGER_GENERATION_RATE: f64 = 1.0;

pub fn number<R: Rand>(rand: &mut R) -> f64 {
    let num = rand.next_float() * MAX_RANDOM_NUMBER;
    if rand.coinflip(INTEGER_GENERATION_RATE) {
        num
    } else {
        num.floor()
    }
}

pub fn string<R: Rand>(rand: &mut R) -> String {
    let size = size(rand);
    let mut string = String::with_capacity(size);

    for _ in 0..size {
        // printable ASCII chars
        string.push((rand.between(32, 126) as u8).into());
    }

    string
}

pub fn boolean<R: Rand>(rand: &mut R) -> bool {
    rand.coinflip(0.5)
}

pub fn size<R: Rand>(rand: &mut R) -> usize {
    rand.between(0, MAX_RANDOM_SIZE + 1)
}

pub type Distribution<K> = BTreeMap<K, f64>;

pub fn redistribute<R, K>(rand: &mut R, dist: &mut Distribution<K>)
where
    R: Rand,
{
    let mut remaining = 1.0;
    let size = dist.len();

    for (idx, value) in dist.values_mut().enumerate() {
        *value = if idx == size - 1 {
            remaining
        } else {
            rand.next_float() * remaining
        };

        remaining -= *value;
        assert!(remaining >= 0.0);
    }
}

pub trait TrySample<T, R: Rand> {
    fn sample(&self, rand: &mut R) -> Result<T>;
}

impl<K: Clone, R: Rand> TrySample<K, R> for Distribution<K> {
    fn sample(&self, rand: &mut R) -> Result<K> {
        if self.is_empty() {
            bail!("distribution to sample is empty");
        }

        if self.len() == 1 {
            let key = self.keys().next().unwrap();
            return Ok(key.clone());
        }

        let p = rand.next_float();
        let mut total = 0.;
        for (key, prob) in self {
            total += prob;
            if p < total {
                return Ok(key.clone());
            }
        }

        bail!("sampling error")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libafl_bolts::rands::{Rand, StdRand};

    // --- float ---

    #[test]
    fn test_float_range() {
        let mut rand = StdRand::with_seed(42);
        for _ in 0..1000 {
            let v = number(&mut rand);
            assert!(v >= 0.0);
            assert!(v < MAX_RANDOM_NUMBER);
        }
    }

    // --- string ---

    #[test]
    fn test_string_ascii_printable() {
        let mut rand = StdRand::with_seed(42);
        for _ in 0..100 {
            let s = string(&mut rand);
            for ch in s.chars() {
                assert!(
                    (32..=126).contains(&(ch as u32)),
                    "char '{}' (0x{:02x}) is not printable ASCII",
                    ch,
                    ch as u32
                );
            }
        }
    }

    #[test]
    fn test_string_length_bounded() {
        let mut rand = StdRand::with_seed(42);
        for _ in 0..100 {
            let s = string(&mut rand);
            assert!(s.len() <= MAX_RANDOM_SIZE + 1);
        }
    }

    // --- boolean ---

    #[test]
    fn test_boolean_produces_both_values() {
        let mut rand = StdRand::with_seed(42);
        let mut seen_true = false;
        let mut seen_false = false;
        for _ in 0..100 {
            if boolean(&mut rand) {
                seen_true = true;
            } else {
                seen_false = true;
            }
            if seen_true && seen_false {
                break;
            }
        }
        assert!(
            seen_true && seen_false,
            "boolean should produce both true and false"
        );
    }

    // --- size ---

    #[test]
    fn test_size_range() {
        let mut rand = StdRand::with_seed(42);
        for _ in 0..1000 {
            let s = size(&mut rand);
            assert!(s <= MAX_RANDOM_SIZE + 1);
        }
    }

    // --- redistribute ---

    #[test]
    fn test_redistribute_sums_to_one() {
        let mut rand = StdRand::with_seed(42);
        let mut dist: Distribution<&str> = BTreeMap::new();
        dist.insert("a", 0.0);
        dist.insert("b", 0.0);
        dist.insert("c", 0.0);

        redistribute(&mut rand, &mut dist);

        let total: f64 = dist.values().sum();
        assert!((total - 1.0).abs() < 1e-10, "total was {}", total);
    }

    #[test]
    fn test_redistribute_all_non_negative() {
        let mut rand = StdRand::with_seed(42);
        for seed in 0..100 {
            rand.set_seed(seed);
            let mut dist: Distribution<u32> = BTreeMap::new();
            dist.insert(0, 0.0);
            dist.insert(1, 0.0);
            dist.insert(2, 0.0);
            dist.insert(3, 0.0);

            redistribute(&mut rand, &mut dist);

            for (key, value) in &dist {
                assert!(*value >= 0.0, "key {} had negative value {}", key, value);
            }
        }
    }

    #[test]
    fn test_redistribute_single_entry() {
        let mut rand = StdRand::with_seed(42);
        let mut dist: Distribution<&str> = BTreeMap::new();
        dist.insert("only", 0.0);

        redistribute(&mut rand, &mut dist);

        assert_eq!(dist["only"], 1.0);
    }

    // --- Distribution::sample ---

    #[test]
    fn test_distribution_sample_empty_errors() {
        let mut rand = StdRand::with_seed(42);
        let dist: Distribution<u32> = BTreeMap::new();
        assert!(dist.sample(&mut rand).is_err());
    }

    #[test]
    fn test_distribution_sample_single_element() {
        let mut rand = StdRand::with_seed(42);
        let mut dist: Distribution<&str> = BTreeMap::new();
        dist.insert("only", 1.0);

        for _ in 0..100 {
            let result: &str = dist.sample(&mut rand).unwrap();
            assert_eq!(result, "only");
        }
    }

    #[test]
    fn test_distribution_sample_respects_weights() {
        let mut rand = StdRand::with_seed(42);
        let mut dist: Distribution<&str> = BTreeMap::new();
        dist.insert("heavy", 0.99);
        dist.insert("light", 0.01);

        let mut heavy_count = 0;
        let n = 1000;
        for _ in 0..n {
            if dist.sample(&mut rand).unwrap() == "heavy" {
                heavy_count += 1;
            }
        }

        // With p=0.99, expect ~990 hits; assert at least 900
        assert!(
            heavy_count > 900,
            "heavy was sampled only {} / {} times",
            heavy_count,
            n
        );
    }

    #[test]
    fn test_distribution_sample_deterministic() {
        let mut a = StdRand::with_seed(77);
        let mut b = StdRand::with_seed(77);
        let mut dist: Distribution<u32> = BTreeMap::new();
        dist.insert(1, 0.25);
        dist.insert(2, 0.25);
        dist.insert(3, 0.25);
        dist.insert(4, 0.25);

        for _ in 0..100 {
            let va: u32 = dist.sample(&mut a).unwrap();
            let vb: u32 = dist.sample(&mut b).unwrap();
            assert_eq!(va, vb);
        }
    }
}
