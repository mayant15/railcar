// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::{bail, Result};

use std::collections::BTreeMap;

use libafl_bolts::rands::{Rand, StdRand};
use serde::{Deserialize, Serialize};

use crate::config::{DEFAULT_CONTEXT_LENGTH, GENERATE_FLOATS, MAX_RANDOM_NUMBER, MAX_RANDOM_SIZE};

#[derive(Debug, Serialize, Deserialize)]
pub struct BytesRand {
    buf: Vec<u8>,
    pointer: usize,
    rand: StdRand,
}

fn next_u64(bytes: &[u8]) -> u64 {
    assert!(bytes.len() >= 8);
    let mut next: [u8; 8] = [0; 8];
    next.copy_from_slice(&bytes[0..8]);
    u64::from_le_bytes(next)
}

impl BytesRand {
    pub fn new(bytes: &[u8]) -> Self {
        let seed = next_u64(bytes);
        Self {
            buf: bytes.to_vec(),
            pointer: 8,
            rand: StdRand::with_seed(seed),
        }
    }
}

impl Rand for BytesRand {
    fn set_seed(&mut self, _seed: u64) {
        unimplemented!("This random number generated should return bytes off a given byte buffer")
    }

    fn next(&mut self) -> u64 {
        if self.buf.len() - self.pointer >= 8 {
            // we have more 8 bytes
            let next = next_u64(&self.buf[self.pointer..]);
            self.pointer += 8;
            next
        } else {
            // start generating random values
            self.rand.next()
        }
    }
}

pub fn float<R: Rand>(rand: &mut R) -> f64 {
    // I return an integer here because integers are more likely to be valid inputs
    // to things like array lengths
    let num = rand.next_float() * MAX_RANDOM_NUMBER;
    if GENERATE_FLOATS {
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

pub fn context_byte_seq<R: Rand>(rand: &mut R, len: Option<usize>) -> Vec<u8> {
    let len = len.unwrap_or(DEFAULT_CONTEXT_LENGTH);
    let mut seq = vec![];
    extend_context_byte_seq(rand, &mut seq, Some(len));
    seq
}

pub fn extend_context_byte_seq<R: Rand>(rand: &mut R, bytes: &mut Vec<u8>, len: Option<usize>) {
    let len = len.unwrap_or(DEFAULT_CONTEXT_LENGTH);

    let old_len = bytes.len();
    bytes.resize(len, 0);

    if old_len >= len {
        return;
    }

    let mut next = old_len;
    while next < len {
        let step = (len - next).min(8);
        let slice = &mut bytes[next..(next + step)];
        let next_int = rand.next();
        let src = &next_int.to_le_bytes()[0..step];
        slice.copy_from_slice(src);
        next += 8;
    }
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
    use crate::config::{DEFAULT_CONTEXT_LENGTH, MAX_RANDOM_NUMBER, MAX_RANDOM_SIZE};
    use libafl_bolts::rands::StdRand;

    // --- BytesRand ---

    #[test]
    fn test_bytes_rand_consumes_buffer_first() {
        // The condition is `len - pointer >= 8`, so 8 remaining bytes suffice.
        // 24 bytes = 8 (seed) + 16 remaining.
        // Call 1: remaining=16 >= 8 → reads bytes[8..16], pointer=16
        // Call 2: remaining=8 >= 8 → reads bytes[16..24], pointer=24
        let bytes: Vec<u8> = (0..24).collect();
        let mut rand = BytesRand::new(&bytes);

        let first = rand.next();
        let expected = next_u64(&bytes[8..16]);
        assert_eq!(first, expected);

        let second = rand.next();
        let expected = next_u64(&bytes[16..24]);
        assert_eq!(second, expected);
    }

    #[test]
    fn test_bytes_rand_falls_back_to_std_rand() {
        // 15 bytes = 8 (seed) + 7 remaining. remaining=7 is NOT >= 8,
        // so the very first next() falls back to StdRand.
        let bytes: Vec<u8> = (0..15).collect();
        let seed = next_u64(&bytes[0..8]);
        let mut rand = BytesRand::new(&bytes);
        let mut expected_rand = StdRand::with_seed(seed);

        let fallback = rand.next();
        assert_eq!(fallback, expected_rand.next());
    }

    #[test]
    fn test_bytes_rand_deterministic() {
        let bytes: Vec<u8> = (0..64).collect();
        let mut a = BytesRand::new(&bytes);
        let mut b = BytesRand::new(&bytes);

        for _ in 0..20 {
            assert_eq!(a.next(), b.next());
        }
    }

    // --- float ---

    #[test]
    fn test_float_range() {
        let mut rand = StdRand::with_seed(42);
        for _ in 0..1000 {
            let v = float(&mut rand);
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

    // --- context_byte_seq / extend_context_byte_seq ---

    #[test]
    fn test_context_byte_seq_default_length() {
        let mut rand = StdRand::with_seed(42);
        let seq = context_byte_seq(&mut rand, None);
        assert_eq!(seq.len(), DEFAULT_CONTEXT_LENGTH);
    }

    #[test]
    fn test_context_byte_seq_custom_length() {
        let mut rand = StdRand::with_seed(42);
        let seq = context_byte_seq(&mut rand, Some(64));
        assert_eq!(seq.len(), 64);
    }

    #[test]
    fn test_context_byte_seq_deterministic() {
        let mut a = StdRand::with_seed(99);
        let mut b = StdRand::with_seed(99);
        assert_eq!(
            context_byte_seq(&mut a, Some(32)),
            context_byte_seq(&mut b, Some(32))
        );
    }

    #[test]
    fn test_extend_context_byte_seq_grows() {
        let mut rand = StdRand::with_seed(42);
        let mut bytes = vec![0xAA; 8];
        extend_context_byte_seq(&mut rand, &mut bytes, Some(32));
        assert_eq!(bytes.len(), 32);
        // original prefix is preserved
        assert_eq!(&bytes[..8], &[0xAA; 8]);
    }

    #[test]
    fn test_extend_context_byte_seq_no_shrink() {
        let mut rand = StdRand::with_seed(42);
        let mut bytes = vec![0xBB; 64];
        let original = bytes.clone();
        extend_context_byte_seq(&mut rand, &mut bytes, Some(32));
        // when old_len >= len, truncates to len but doesn't fill
        assert_eq!(bytes.len(), 32);
        assert_eq!(&bytes[..], &original[..32]);
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

    // --- next_u64 ---

    #[test]
    fn test_next_u64_little_endian() {
        let bytes = [1u8, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(next_u64(&bytes), 1);

        let bytes = [0u8, 1, 0, 0, 0, 0, 0, 0];
        assert_eq!(next_u64(&bytes), 256);
    }
}
