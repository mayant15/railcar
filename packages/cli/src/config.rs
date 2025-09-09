// SPDX-License-Identifier: AGPL-3.0-or-later

use std::num::NonZero;

use static_assertions::const_assert;

pub const MAX_INPUT_LENGTH: NonZero<usize> = NonZero::new(4096).unwrap();
pub const MIN_INPUT_LENGTH: NonZero<usize> = NonZero::new(8).unwrap();
pub const INITIAL_CORPUS_SIZE: usize = 32;

pub const MAX_CONTEXT_MUTATION_ITERATIONS_LOG2: usize = 7;
const_assert!(MAX_CONTEXT_MUTATION_ITERATIONS_LOG2 > 0);

pub const MAX_SCHEMA_MUTATION_TYPE_GUESS_CLASSES_COUNT: NonZero<usize> = NonZero::new(5).unwrap();
pub const MAX_SCHEMA_MUTATION_TYPE_GUESS_PROPERTIES_COUNT: NonZero<usize> =
    NonZero::new(5).unwrap();
pub const MAX_SCHEMA_MUTATION_ARGC: usize = 6;
pub const MUTATE_SCHEMA_ARGC_FILL_WITH_ANY: bool = true;
pub const MUTATE_SCHEMA_PRESERVE_CLASS_STRUCTURE: bool = true;
pub const MUTATE_SCHEMA_CREATE_ANY_GUESS_RATE: f64 = 0.05;
const_assert!(MUTATE_SCHEMA_CREATE_ANY_GUESS_RATE <= 1.0);

pub const COVERAGE_MAP_SIZE: usize = 1 << 16;

pub const METRICS_BUFFER_SIZE: usize = 128;

pub const CORPUS_CACHE_SIZE: usize = 512;
