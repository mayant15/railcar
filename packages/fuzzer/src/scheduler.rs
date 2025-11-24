// SPDX-License-Identifier: AGPL-3.0-or-later

use libafl::{
    corpus::Testcase,
    schedulers::{testcase_score::CorpusWeightTestcaseScore, TestcaseScore, WeightedScheduler},
    state::HasCorpus,
    HasMetadata,
};

pub struct ValidityTestcaseScore;

impl<I, S> TestcaseScore<I, S> for ValidityTestcaseScore
where
    S: HasCorpus<I> + HasMetadata,
{
    fn compute(state: &S, entry: &mut Testcase<I>) -> Result<f64, libafl::Error> {
        let is_valid = entry
            .hit_feedbacks()
            .iter()
            .any(|cow| *cow == "ValidityFeedback");

        CorpusWeightTestcaseScore::compute(state, entry).map(|weight| {
            if is_valid {
                weight * 2.0
            } else {
                weight
            }
        })
    }
}

pub type StdScheduler<C, O> = WeightedScheduler<C, ValidityTestcaseScore, O>;
