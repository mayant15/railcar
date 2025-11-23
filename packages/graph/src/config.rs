// SPDX-License-Identifier: AGPL-3.0-or-later

use static_assertions::const_assert;

pub const MAX_COMPLETION_ITER: usize = 70;
pub const MAX_COMPLETE_WITH_ENDPOINTS: usize = 10;
const_assert!(MAX_COMPLETE_WITH_ENDPOINTS < MAX_COMPLETION_ITER);

pub const GENERATE_FLOATS: bool = false;
/// Maximum random number generated for functions that need number. Keep this low because this
/// could be an array length
pub const MAX_RANDOM_NUMBER: f64 = 1000.0;
pub const MAX_RANDOM_SIZE: usize = 10;

pub const DEFAULT_CONTEXT_LENGTH: usize = 128;

pub const ENABLE_LIKELIHOOD_BASED_CONCRETIZATION: bool = false;

/// Probability of filling unfilled input ports with constants during graph completion
pub const FILL_CONSTANT_RATE: f64 = 0.5;
const_assert!(FILL_CONSTANT_RATE <= 1.0);

/// Probability of filling unfilled input ports with existing nodes during graph completion.
/// If an appropriate node is not available a new one will be created.
pub const FILL_REUSE_RATE: f64 = 0.0;
const_assert!(FILL_REUSE_RATE <= 1.0);

pub const SEQUENCE_COMPLETION_REUSE_RATE: f64 = 0.5;
const_assert!(SEQUENCE_COMPLETION_REUSE_RATE <= 1.0);

/// Size of the coverage map
pub const COVERAGE_MAP_SIZE: usize = 1 << 15;
