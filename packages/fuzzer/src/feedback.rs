#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{borrow::Cow, marker::PhantomData};

use libafl::{
    corpus::Testcase,
    events::{Event, EventFirer, EventWithStats},
    executors::ExitKind,
    feedbacks::{AflMapFeedback, Feedback, StateInitializer},
    inputs::Input,
    monitors::stats::{AggregatorOps, UserStats, UserStatsValue},
    state::{HasCorpus, HasExecutions},
    HasNamedMetadata,
};
use libafl_bolts::{
    tuples::{Handle, Handled, MatchFirstType, MatchName, MatchNameRef},
    Named,
};
use serde::{Deserialize, Serialize};

use crate::{
    inputs::HasSeqLen,
    observer::{
        ApiProgressObserver, CoverageObserver, Observers, TotalEdgesObserver, ValidityObserver,
    },
};

pub type CoverageFeedback = AflMapFeedback<CoverageObserver, CoverageObserver>;

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
struct ValidityMetadata {
    num_valid_executions: u64,
}

libafl_bolts::impl_serdeany!(ValidityMetadata);

/// Checks if the validity observer is true.
pub struct ValidityFeedback {
    handle: Handle<ValidityObserver>,
    last_result: Option<bool>,
}

impl ValidityFeedback {
    pub fn new(observer: Handle<ValidityObserver>) -> Self {
        Self {
            last_result: None,
            handle: observer,
        }
    }
}

impl<EM, I, OT, S> Feedback<EM, I, OT, S> for ValidityFeedback
where
    OT: MatchName,
    EM: EventFirer<I, S>,
    S: HasNamedMetadata + HasExecutions,
{
    fn is_interesting(
        &mut self,
        _state: &mut S,
        _manager: &mut EM,
        _input: &I,
        observers: &OT,
        _exit_kind: &ExitKind,
    ) -> Result<bool, libafl::Error> {
        let Some(observer) = observers.get(&self.handle) else {
            return Err(libafl::Error::illegal_state(
                "missing validity observer".to_string(),
            ));
        };
        let is_valid_input = observer.is_valid();
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

struct TotalEdgesFeedback {
    edges: u32,
    last_result: bool,
    handle: Handle<TotalEdgesObserver>,
}

impl TotalEdgesFeedback {
    fn new(handle: Handle<TotalEdgesObserver>) -> Self {
        Self {
            edges: 0,
            last_result: false,
            handle,
        }
    }
}

impl Named for TotalEdgesFeedback {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("TotalEdges");
        &NAME
    }
}

impl<EM, I, OT, S> Feedback<EM, I, OT, S> for TotalEdgesFeedback
where
    EM: EventFirer<I, S>,
    OT: MatchName,
    S: HasExecutions,
{
    fn last_result(&self) -> Result<bool, libafl::Error> {
        Ok(self.last_result)
    }

    fn is_interesting(
        &mut self,
        state: &mut S,
        manager: &mut EM,
        _input: &I,
        observers: &OT,
        _exit_kind: &ExitKind,
    ) -> Result<bool, libafl::Error> {
        let Some(observer) = observers.get(&self.handle) else {
            return Err(libafl::Error::illegal_state("missing total edges observer"));
        };

        let new_edges = *observer.value();

        if new_edges < self.edges {
            return Err(libafl::Error::illegal_state(
                "total number of instrumented edges must not decrease",
            ));
        }

        // if the total number of instrumented edges has increased, record it
        let is_interesting = if new_edges > self.edges {
            self.edges = new_edges;
            manager.fire(
                state,
                EventWithStats::with_current_time(
                    Event::UpdateUserStats {
                        name: Cow::Borrowed("totaledges"),
                        value: UserStats::new(
                            UserStatsValue::Number(new_edges.into()),
                            AggregatorOps::Sum,
                        ),
                        phantom: PhantomData,
                    },
                    *state.executions(),
                ),
            )?;
            true
        } else {
            false
        };

        self.last_result = is_interesting;
        Ok(is_interesting)
    }
}

impl<S> StateInitializer<S> for TotalEdgesFeedback {}

struct ApiProgressFeedback {
    last_result: bool,
    max_progress: i64,
    handle: Handle<ApiProgressObserver>,
}

impl ApiProgressFeedback {
    fn new(handle: Handle<ApiProgressObserver>) -> Self {
        Self {
            handle,
            max_progress: 0,
            last_result: false,
        }
    }

    /// Quadratic curve that peaks at (M, M). This looks for API chains of
    /// length M that fully complete.
    fn progress(successful: i64, total: i64) -> i64 {
        const M: i64 = 10;
        let a = successful - M;
        let b = total - M;
        (M * M) - (a * a + b * b)
    }
}

impl Named for ApiProgressFeedback {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("ApiProgressFeedback");
        &NAME
    }
}

impl<S> StateInitializer<S> for ApiProgressFeedback {}

impl<EM, I, OT, S> Feedback<EM, I, OT, S> for ApiProgressFeedback
where
    OT: MatchName,
    I: HasSeqLen,
{
    fn last_result(&self) -> Result<bool, libafl::Error> {
        Ok(self.last_result)
    }

    fn is_interesting(
        &mut self,
        _state: &mut S,
        _manager: &mut EM,
        input: &I,
        observers: &OT,
        _exit_kind: &ExitKind,
    ) -> Result<bool, libafl::Error> {
        let Some(observer) = observers.get(&self.handle) else {
            return Err(libafl::Error::illegal_state(
                "missing api progress observer".to_owned(),
            ));
        };
        let successful = *observer.value();
        let total: u32 = input.seq_len().try_into()?;
        let progress = Self::progress(successful.into(), total.into());

        if progress > self.max_progress {
            self.max_progress = progress;
            self.last_result = true;
            Ok(true)
        } else {
            self.last_result = false;
            Ok(false)
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
struct StdFeedbackMetadata {
    valid_corpus_size: u64,
    total_edges_instrumented: u32,
}

libafl_bolts::impl_serdeany!(StdFeedbackMetadata);

pub struct StdFeedback {
    use_validity: bool,

    // sub feedbacks
    total_edges: TotalEdgesFeedback,
    validity: ValidityFeedback,
    total_coverage: CoverageFeedback,
    valid_coverage: CoverageFeedback,
    api_progress: ApiProgressFeedback,

    last_result: Option<bool>,
}

impl StdFeedback {
    pub fn new(use_validity: bool, observers: &Observers) -> Self {
        let (coverage, (validity, (total_edges, (api_progress, _)))) = observers;
        Self {
            use_validity,
            total_edges: TotalEdgesFeedback::new(total_edges.handle()),
            validity: ValidityFeedback::new(validity.handle()),
            total_coverage: CoverageFeedback::with_name("TotalCoverage", coverage),
            valid_coverage: CoverageFeedback::with_name("ValidCoverage", coverage),
            api_progress: ApiProgressFeedback::new(api_progress.handle()),
            last_result: None,
        }
    }
}

impl<EM, I, OT, S> Feedback<EM, I, OT, S> for StdFeedback
where
    I: Input + HasSeqLen,
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

        let is_new_instrumentation = self
            .total_edges
            .is_interesting(state, manager, input, observers, exit_kind)?;

        let is_new_valid_coverage = if self.use_validity && is_valid {
            self.valid_coverage
                .is_interesting(state, manager, input, observers, exit_kind)?
        } else {
            false
        };

        let is_better_progress = self
            .api_progress
            .is_interesting(state, manager, input, observers, exit_kind)?;

        let is_interesting = is_new_total_coverage
            || is_new_instrumentation
            || is_new_valid_coverage
            || is_better_progress;

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
