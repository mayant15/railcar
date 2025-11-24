// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::{bail, Result};

#[expect(clippy::disallowed_types)]
use std::collections::HashMap;

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
        if self.buf.len() - self.pointer > 8 {
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

#[expect(clippy::disallowed_types)]
pub type Distribution<K> = HashMap<K, f64>;

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
