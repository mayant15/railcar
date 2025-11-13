#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{borrow::Cow, cell::RefCell, marker::PhantomData};

use libafl::{
    corpus::Testcase,
    events::{Event, EventFirer, EventWithStats},
    executors::ExitKind,
    feedbacks::{AflMapFeedback, Feedback, StateInitializer},
    inputs::Input,
    monitors::stats::{AggregatorOps, UserStats, UserStatsValue},
    observers::{HitcountsMapObserver, RefCellValueObserver, StdMapObserver},
    state::{HasCorpus, HasExecutions},
    HasNamedMetadata,
};
use libafl_bolts::{
    ownedref::OwnedRef,
    shmem::ShMem,
    tuples::{Handle, Handled, MatchFirstType, MatchName, MatchNameRef},
    Named,
};
use serde::{Deserialize, Serialize};

type CoverageObserver = HitcountsMapObserver<StdMapObserver<'static, u8, false>>;
type CoverageFeedback = AflMapFeedback<CoverageObserver, CoverageObserver>;

#[inline]
unsafe fn get_coverage_slice<S: ShMem>(shmem: &mut S) -> &mut [u8] {
    &mut shmem[4..]
}

#[inline]
unsafe fn get_total_edges(coverage_ptr: *const u8) -> u32 {
    *coverage_ptr.sub(4).cast()
}

/// Create a new coverage observer
///
/// This is a view over a previously allocated memory buffer. The coverage map is a &[u8]
/// indexed by edge IDs with each u8 their hitcount. This is shared with the worker process
/// and should therefore be allocated via ShMem. The worker process is responsible for updating
/// the map as the target executes.
///
/// The first four bytes of the coverage map encode the total number of edges, as a u32. We
/// should ideally have a better abstraction here than pointer arithmetic but meh.
///
/// See Worker::coverage_mut() for more details.
pub fn coverage_observer<S>(shmem: &mut S) -> CoverageObserver
where
    S: ShMem,
{
    HitcountsMapObserver::new(unsafe {
        let map = get_coverage_slice(shmem);
        StdMapObserver::from_mut_ptr("CodeCoverage", map.as_mut_ptr(), map.len())
    })
}

// TODO: Ideally this shouldn't be global. The RefCell approach doesn't seem to work, the
// underlying boolean is copied at some point and the observer always sees a stale value.
static mut IS_VALID_INPUT: bool = true;

pub type Validity = bool;

/// Create a new validity observer
pub fn validity_observer() -> (RefCell<Validity>, RefCellValueObserver<'static, Validity>) {
    let cell = RefCell::new(unsafe { IS_VALID_INPUT });
    let observer = RefCellValueObserver::new("IsValidInput", unsafe { OwnedRef::from_ptr(&cell) });
    (cell, observer)
}

pub fn set_valid(value: bool) {
    unsafe {
        IS_VALID_INPUT = value;
    }
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
struct ValidityMetadata {
    num_valid_executions: u64,
}

libafl_bolts::impl_serdeany!(ValidityMetadata);

pub struct ValidityFeedback {
    last_result: Option<bool>,
}

impl ValidityFeedback {
    pub fn new() -> Self {
        Self { last_result: None }
    }
}

impl Default for ValidityFeedback {
    fn default() -> Self {
        Self::new()
    }
}

impl<EM, I, OT, S> Feedback<EM, I, OT, S> for ValidityFeedback
where
    OT: MatchFirstType,
    EM: EventFirer<I, S>,
    S: HasNamedMetadata + HasExecutions,
{
    fn is_interesting(
        &mut self,
        _state: &mut S,
        _manager: &mut EM,
        _input: &I,
        _observers: &OT,
        _exit_kind: &ExitKind,
    ) -> Result<bool, libafl::Error> {
        let is_valid_input = unsafe { IS_VALID_INPUT };
        self.last_result = Some(is_valid_input);
        Ok(is_valid_input)
    }

    fn last_result(&self) -> Result<bool, libafl::Error> {
        self.last_result.ok_or(libafl::Error::illegal_state(
            "ValidityFeedback::last_result called before Feedback was run",
        ))
    }

    fn append_metadata(
        &mut self,
        state: &mut S,
        manager: &mut EM,
        _observers: &OT,
        _testcase: &mut Testcase<I>,
    ) -> Result<(), libafl::Error> {
        let is_valid = <ValidityFeedback as Feedback<EM, I, OT, S>>::last_result(self)?;
        if is_valid {
            let valid_execs = {
                let meta = state.named_metadata_mut::<ValidityMetadata>(self.name())?;
                meta.num_valid_executions += 1;
                meta.num_valid_executions
            };

            manager.fire(
                state,
                EventWithStats::with_current_time(
                    Event::UpdateUserStats {
                        name: Cow::Borrowed("validexecs"),
                        value: UserStats::new(
                            UserStatsValue::Number(valid_execs),
                            AggregatorOps::Sum,
                        ),
                        phantom: PhantomData,
                    },
                    *state.executions(),
                ),
            )?;
        }
        Ok(())
    }
}

impl Named for ValidityFeedback {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("ValidityFeedback");
        &NAME
    }
}

impl<S> StateInitializer<S> for ValidityFeedback
where
    S: HasNamedMetadata,
{
    fn init_state(&mut self, state: &mut S) -> Result<(), libafl::Error> {
        state.add_named_metadata(self.name(), ValidityMetadata::default());
        Ok(())
    }
}
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
struct StdFeedbackMetadata {
    valid_corpus_size: u64,
    total_edges_instrumented: u32,
}

libafl_bolts::impl_serdeany!(StdFeedbackMetadata);

pub struct StdFeedback {
    validity: ValidityFeedback,
    total_coverage: CoverageFeedback,
    valid_coverage: CoverageFeedback,

    use_validity: bool,
    last_result: Option<bool>,
    map_ref: Handle<CoverageObserver>,
}

impl StdFeedback {
    pub fn new(coverage_map: &CoverageObserver, use_validity: bool) -> Self {
        Self {
            use_validity,
            validity: ValidityFeedback::new(),
            total_coverage: CoverageFeedback::with_name("TotalCoverage", coverage_map),
            valid_coverage: CoverageFeedback::with_name("ValidCoverage", coverage_map),
            map_ref: coverage_map.handle(),
            last_result: None,
        }
    }
}

impl<EM, I, OT, S> Feedback<EM, I, OT, S> for StdFeedback
where
    I: Input,
    S: HasNamedMetadata + HasCorpus<I> + Serialize + HasExecutions,
    OT: MatchFirstType + MatchName + MatchNameRef,
    EM: EventFirer<I, S>,
{
    fn is_interesting(
        &mut self,
        state: &mut S,
        manager: &mut EM,
        input: &I,
        observers: &OT,
        exit_kind: &ExitKind,
    ) -> Result<bool, libafl::Error> {
        if !matches!(exit_kind, ExitKind::Ok) {
            // this is a crash that was deemed uninteresting by UniqCrashFeedback,
            // no need to save this to the corpus
            self.last_result = Some(false);
            return Ok(false);
        }

        let is_new_total_coverage = self
            .total_coverage
            .is_interesting(state, manager, input, observers, exit_kind)?;

        let is_valid = self
            .validity
            .is_interesting(state, manager, input, observers, exit_kind)?;

        let is_interesting = if self.use_validity && is_valid {
            let is_new_valid_coverage = self
                .valid_coverage
                .is_interesting(state, manager, input, observers, exit_kind)?;
            is_new_total_coverage || is_new_valid_coverage
        } else {
            is_new_total_coverage
        };

        self.last_result = Some(is_interesting);
        Ok(is_interesting)
    }

    fn last_result(&self) -> Result<bool, libafl::Error> {
        self.last_result.ok_or(libafl::Error::illegal_state(
            "StdFeedback::last_result called before Feedback was run",
        ))
    }

    /// The scheduler needs to know if a testcase is valid or not. Append ValidityFeedback to the
    /// list of hit feedbacks if that is the case.
    fn append_hit_feedbacks(&self, list: &mut Vec<Cow<'static, str>>) -> Result<(), libafl::Error> {
        if <StdFeedback as Feedback<EM, I, OT, S>>::last_result(self)? {
            list.push(self.name().clone());
            if self.use_validity {
                let is_valid =
                    <ValidityFeedback as Feedback<EM, I, OT, S>>::last_result(&self.validity)?;
                if is_valid {
                    list.push(self.validity.name().clone());
                }
            }
        }
        Ok(())
    }

    fn append_metadata(
        &mut self,
        state: &mut S,
        manager: &mut EM,
        observers: &OT,
        testcase: &mut Testcase<I>,
    ) -> Result<(), libafl::Error> {
        self.total_coverage
            .append_metadata(state, manager, observers, testcase)?;
        self.validity
            .append_metadata(state, manager, observers, testcase)?;

        let is_valid = <ValidityFeedback as Feedback<EM, I, OT, S>>::last_result(&self.validity)?;
        let is_interesting = <StdFeedback as Feedback<EM, I, OT, S>>::last_result(self)?;

        // new valid input saved to the corpus, record this is stats
        if is_interesting && is_valid {
            let valid_corpus_count = {
                let meta = state.named_metadata_mut::<StdFeedbackMetadata>(self.name())?;
                meta.valid_corpus_size += 1;
                meta.valid_corpus_size
            };

            manager.fire(
                state,
                EventWithStats::with_current_time(
                    Event::UpdateUserStats {
                        name: Cow::Borrowed("validcorpus"),
                        value: UserStats::new(
                            UserStatsValue::Number(valid_corpus_count),
                            AggregatorOps::Sum,
                        ),
                        phantom: PhantomData,
                    },
                    *state.executions(),
                ),
            )?;
        }

        // if the total number of instrumented edges has increased, record it
        let map = observers.get(&self.map_ref).unwrap().map();
        let total_edges = unsafe { get_total_edges(map.as_ptr()) };
        let has_new_instrumentation = {
            let meta = state.named_metadata_mut::<StdFeedbackMetadata>(self.name())?;
            if total_edges > meta.total_edges_instrumented {
                meta.total_edges_instrumented = total_edges;
                true
            } else {
                false
            }
        };

        if has_new_instrumentation {
            manager.fire(
                state,
                EventWithStats::with_current_time(
                    Event::UpdateUserStats {
                        name: Cow::Borrowed("totaledges"),
                        value: UserStats::new(
                            UserStatsValue::Number(total_edges.into()),
                            AggregatorOps::Sum,
                        ),
                        phantom: PhantomData,
                    },
                    *state.executions(),
                ),
            )?;
        }

        // we only want to update validity coverage map history when we find a valid input
        if self.use_validity && is_valid {
            self.valid_coverage
                .append_metadata(state, manager, observers, testcase)?;
        }

        Ok(())
    }
}

impl<S> StateInitializer<S> for StdFeedback
where
    S: HasNamedMetadata,
{
    fn init_state(&mut self, state: &mut S) -> Result<(), libafl::Error> {
        self.total_coverage.init_state(state)?;
        self.validity.init_state(state)?;
        if self.use_validity {
            self.valid_coverage.init_state(state)?;
        }
        state.add_named_metadata(self.name(), StdFeedbackMetadata::default());
        Ok(())
    }
}

impl Named for StdFeedback {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("StdFeedback");
        &NAME
    }
}

pub struct UniqCrashFeedback {
    coverage: CoverageFeedback,
    last_result: Option<bool>,
}

impl UniqCrashFeedback {
    pub fn new(coverage_map: &CoverageObserver) -> Self {
        Self {
            coverage: CoverageFeedback::with_name("CrashCoverage", coverage_map),
            last_result: None,
        }
    }
}

impl<EM, I, OT, S> Feedback<EM, I, OT, S> for UniqCrashFeedback
where
    I: Input,
    S: HasNamedMetadata + HasCorpus<I> + Serialize + HasExecutions,
    OT: MatchFirstType + MatchName,
    EM: EventFirer<I, S>,
{
    fn is_interesting(
        &mut self,
        state: &mut S,
        manager: &mut EM,
        input: &I,
        observers: &OT,
        exit_kind: &ExitKind,
    ) -> Result<bool, libafl::Error> {
        if !matches!(exit_kind, ExitKind::Crash | ExitKind::Timeout) {
            self.last_result = Some(false);
            return Ok(false);
        }

        let is_new_coverage = self
            .coverage
            .is_interesting(state, manager, input, observers, exit_kind)?;

        self.last_result = Some(is_new_coverage);
        Ok(is_new_coverage)
    }

    fn last_result(&self) -> Result<bool, libafl::Error> {
        self.last_result.ok_or(libafl::Error::illegal_state(
            "UniqCrashFeedback::last_result called before Feedback was run",
        ))
    }

    fn append_metadata(
        &mut self,
        state: &mut S,
        manager: &mut EM,
        observers: &OT,
        testcase: &mut Testcase<I>,
    ) -> Result<(), libafl::Error> {
        <CoverageFeedback as Feedback<EM, I, OT, S>>::append_metadata(
            &mut self.coverage,
            state,
            manager,
            observers,
            testcase,
        )?;
        Ok(())
    }
}

impl<S> StateInitializer<S> for UniqCrashFeedback
where
    S: HasNamedMetadata,
{
    fn init_state(&mut self, state: &mut S) -> Result<(), libafl::Error> {
        self.coverage.init_state(state)
    }
}

impl Named for UniqCrashFeedback {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("UniqCrashFeedback");
        &NAME
    }
}
