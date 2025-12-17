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
    HasMetadata, HasNamedMetadata,
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

/// State metadata with stats about valid inputs processed so far.
#[derive(Serialize, Deserialize, Debug, Default)]
struct ValidInputsMetadata {
    /// Number of valid inputs executed so far
    num_valid_executions: u64,

    /// Number of valid inputs added to the corpus
    num_valid_corpus: u64,
}

libafl_bolts::impl_serdeany!(ValidInputsMetadata);

impl ValidInputsMetadata {
    const NAME: &'static str = "ValidInputsMetadata";

    #[inline]
    fn get<S: HasNamedMetadata>(state: &mut S) -> Result<&mut ValidInputsMetadata, libafl::Error> {
        state.named_metadata_mut::<Self>(Self::NAME)
    }

    #[inline]
    fn init<S: HasNamedMetadata>(state: &mut S) {
        if !state.has_named_metadata::<Self>(Self::NAME) {
            state.add_named_metadata(Self::NAME, Self::default());
        }
    }
}

/// Input metadata that labels each input as valid or invalid in the corpus.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct InputValidityMetadata {
    pub is_valid: bool,
}

libafl_bolts::impl_serdeany!(InputValidityMetadata);

/// Checks if the validity observer is true.
pub struct ValidityFeedback {
    handle: Handle<ValidityObserver>,
    last_result: Option<bool>,
}

impl ValidityFeedback {
    pub fn new(observer: Handle<ValidityObserver>) -> Self {
        Self {
            handle: observer,
            last_result: None,
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
        state: &mut S,
        manager: &mut EM,
        _input: &I,
        observers: &OT,
        _exit_kind: &ExitKind,
    ) -> Result<bool, libafl::Error> {
        let Some(observer) = observers.get(&self.handle) else {
            return Err(libafl::Error::illegal_state(
                "missing validity observer".to_string(),
            ));
        };

        let is_interesting = observer.is_valid();

        if is_interesting {
            let execs = {
                let meta = ValidInputsMetadata::get(state)?;
                meta.num_valid_executions += 1;
                meta.num_valid_executions
            };
            manager.fire(
                state,
                EventWithStats::with_current_time(
                    Event::UpdateUserStats {
                        name: Cow::Borrowed("validexecs"),
                        value: UserStats::new(UserStatsValue::Number(execs), AggregatorOps::Sum),
                        phantom: PhantomData,
                    },
                    *state.executions(),
                ),
            )?
        }

        self.last_result = Some(is_interesting);
        Ok(is_interesting)
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
        testcase: &mut Testcase<I>,
    ) -> Result<(), libafl::Error> {
        let is_valid = <ValidityFeedback as Feedback<EM, I, OT, S>>::last_result(self)?;

        let testcase_metadata_map = testcase.metadata_map_mut();
        testcase_metadata_map.insert(InputValidityMetadata { is_valid });

        // if a new valid input is going into the corpus, record it in stats
        if is_valid {
            let count = {
                let meta = ValidInputsMetadata::get(state)?;
                meta.num_valid_corpus += 1;
                meta.num_valid_corpus
            };
            manager.fire(
                state,
                EventWithStats::with_current_time(
                    Event::UpdateUserStats {
                        name: Cow::Borrowed("validcorpus"),
                        value: UserStats::new(UserStatsValue::Number(count), AggregatorOps::Sum),
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

impl<S: HasNamedMetadata> StateInitializer<S> for ValidityFeedback {
    fn init_state(&mut self, state: &mut S) -> Result<(), libafl::Error> {
        ValidInputsMetadata::init(state);
        Ok(())
    }
}

pub struct TotalEdgesFeedback {
    edges: u32,
    last_result: bool,
    handle: Handle<TotalEdgesObserver>,
}

impl TotalEdgesFeedback {
    pub fn new(handle: Handle<TotalEdgesObserver>) -> Self {
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

        let is_interesting = new_edges > self.edges;

        // if the total number of instrumented edges has increased, record it
        if is_interesting {
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
        }

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

pub struct StdFeedback {
    use_validity: bool,
    last_result: Option<bool>,

    // sub feedbacks
    // TODO: what if we merged all of these into a big StdFeedback
    total_edges: TotalEdgesFeedback,
    validity: ValidityFeedback,
    total_coverage: CoverageFeedback,
    valid_coverage: CoverageFeedback,
    api_progress: ApiProgressFeedback,
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
        let is_valid = self
            .validity
            .is_interesting(state, manager, input, observers, exit_kind)?;

        // must be ExitKind::Ok or invalid.
        // valid crashes deemed uninteresting by UniqCrashFeedback should not
        // go into the corpus.
        // TODO: should we save invalid inputs to the corpus at all?
        let should_consider = matches!(exit_kind, ExitKind::Ok) || !is_valid;
        if !should_consider {
            self.last_result = Some(false);
            return Ok(false);
        }

        let is_new_total_coverage = self
            .total_coverage
            .is_interesting(state, manager, input, observers, exit_kind)?;

        let is_new_valid_coverage = if is_valid {
            self.valid_coverage
                .is_interesting(state, manager, input, observers, exit_kind)?
        } else {
            false
        };

        let _is_new_instrumentation = self
            .total_edges
            .is_interesting(state, manager, input, observers, exit_kind)?;

        let _is_better_progress = self
            .api_progress
            .is_interesting(state, manager, input, observers, exit_kind)?;

        let is_interesting = if self.use_validity {
            is_new_total_coverage || is_new_valid_coverage
        } else {
            is_new_total_coverage
        };
        // || is_new_instrumentation
        // || is_new_valid_coverage
        // || is_better_progress;

        self.last_result = Some(is_interesting);
        Ok(is_interesting)
    }

    fn last_result(&self) -> Result<bool, libafl::Error> {
        self.last_result.ok_or(libafl::Error::illegal_state(
            "StdFeedback::last_result called before Feedback was run",
        ))
    }

    fn append_metadata(
        &mut self,
        state: &mut S,
        manager: &mut EM,
        observers: &OT,
        testcase: &mut Testcase<I>,
    ) -> Result<(), libafl::Error> {
        #[cfg(debug_assertions)]
        {
            // This function only runs when a new input is added to the corpus, so the last
            // feedback must be true.
            let is_interesting = <StdFeedback as Feedback<EM, I, OT, S>>::last_result(self)?;
            debug_assert!(is_interesting);
        }

        *testcase.executions_mut() = *state.executions();

        self.validity
            .append_metadata(state, manager, observers, testcase)?;

        // update stats for total coverage
        self.total_coverage
            .append_metadata(state, manager, observers, testcase)?;

        // we only want to update validity coverage map history when we find a valid input
        let is_valid = <ValidityFeedback as Feedback<EM, I, OT, S>>::last_result(&self.validity)?;
        if is_valid {
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
        self.valid_coverage.init_state(state)?;
        self.validity.init_state(state)?;
        self.total_edges.init_state(state)?;
        self.api_progress.init_state(state)?;
        Ok(())
    }
}

impl Named for StdFeedback {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("StdFeedback");
        &NAME
    }
}

/// Reports true if the input crashes, is valid, and covers new edges.
/// Assumes this is an objective and used alongside StdFeedback.
pub struct UniqCrashFeedback {
    coverage: CoverageFeedback,
    validity_observer: Handle<ValidityObserver>,
    last_result: Option<bool>,
}

impl UniqCrashFeedback {
    pub fn new(observers: &Observers) -> Self {
        let (coverage, (validity, _)) = observers;
        Self {
            coverage: CoverageFeedback::with_name("CrashCoverage", coverage),
            validity_observer: validity.handle(),
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
        if matches!(exit_kind, ExitKind::Ok) {
            self.last_result = Some(false);
            return Ok(false);
        }

        let Some(validity_observer) = observers.get(&self.validity_observer) else {
            return Err(libafl::Error::illegal_state(
                "missing validity observer".to_string(),
            ));
        };

        let is_valid = validity_observer.is_valid();

        let is_new_coverage = self
            .coverage
            .is_interesting(state, manager, input, observers, exit_kind)?;

        let is_interesting = is_valid && is_new_coverage;

        // if this is interesting, we're not going to run feedbacks. Update stats
        // that we would have updated in feedback otherwise.
        if is_interesting {
            let execs = {
                let meta = ValidInputsMetadata::get(state)?;
                meta.num_valid_executions += 1;
                meta.num_valid_executions
            };
            manager.fire(
                state,
                EventWithStats::with_current_time(
                    Event::UpdateUserStats {
                        name: Cow::Borrowed("validexecs"),
                        value: UserStats::new(UserStatsValue::Number(execs), AggregatorOps::Sum),
                        phantom: PhantomData,
                    },
                    *state.executions(),
                ),
            )?
        }

        self.last_result = Some(is_interesting);
        Ok(is_interesting)
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
        self.coverage
            .append_metadata(state, manager, observers, testcase)
    }
}

impl<S> StateInitializer<S> for UniqCrashFeedback
where
    S: HasNamedMetadata,
{
    fn init_state(&mut self, state: &mut S) -> Result<(), libafl::Error> {
        ValidInputsMetadata::init(state);
        self.coverage.init_state(state)
    }
}

impl Named for UniqCrashFeedback {
    fn name(&self) -> &std::borrow::Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("UniqCrashFeedback");
        &NAME
    }
}
