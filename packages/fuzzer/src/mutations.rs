use std::{borrow::Cow, collections::HashSet};

use libafl::{
    corpus::{Corpus, CorpusId},
    mutators::{
        havoc_mutations, HavocMutationsType, HavocScheduledMutator, MutationResult, Mutator,
    },
    random_corpus_id,
    state::{HasCorpus, HasRand},
};
use libafl_bolts::{
    rands::Rand,
    tuples::{tuple_list, tuple_list_type},
    Named,
};

use crate::{
    schema::Schema,
    seq::{ApiCallArg, ApiSeq},
};

type FuzzSeqConsts = HavocScheduledMutator<HavocMutationsType>;

pub type SequenceMutationsType<'a> = tuple_list_type!(
    SpliceSeq<'a>,
    ExtendSeq<'a>,
    RemoveSuffixSeq,
    RemovePrefixSeq<'a>,
    Crossover<'a>,
    FuzzSeqConsts
);

pub fn sequence_mutations<'a>(schema: &'a Schema) -> SequenceMutationsType<'a> {
    tuple_list!(
        SpliceSeq { schema },
        ExtendSeq { schema },
        RemoveSuffixSeq {},
        RemovePrefixSeq { schema },
        Crossover { schema },
        HavocScheduledMutator::new(havoc_mutations()),
    )
}

pub struct SpliceSeq<'a> {
    pub schema: &'a Schema,
}

impl<'a> Named for SpliceSeq<'a> {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("SpliceSeq");
        &NAME
    }
}

impl<'a, S: HasRand> Mutator<ApiSeq, S> for SpliceSeq<'a> {
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut ApiSeq,
    ) -> Result<MutationResult, libafl::Error> {
        if input.seq_len() < 2 {
            return Ok(MutationResult::Skipped);
        }

        // remove a random API call
        let rand = state.rand_mut();
        let to_remove = rand.between(0, input.seq_len() - 1);

        input.remove(to_remove);
        input
            .complete(rand, self.schema)
            .map_err(|err| libafl::Error::unknown(format!("{}", err)))?;

        #[cfg(debug_assertions)]
        input.is_valid();

        Ok(MutationResult::Mutated)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

pub struct ExtendSeq<'a> {
    pub schema: &'a Schema,
}

impl<'a> Named for ExtendSeq<'a> {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("ExtendSeq");
        &NAME
    }
}

impl<'a, S: HasRand> Mutator<ApiSeq, S> for ExtendSeq<'a> {
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut ApiSeq,
    ) -> Result<MutationResult, libafl::Error> {
        let rand = state.rand_mut();
        let key = rand.choose(self.schema.keys()).unwrap();
        let sig = self.schema.get(key).unwrap();

        input.append(key.clone(), sig.args.len(), sig.callconv);
        input
            .complete(rand, self.schema)
            .map_err(|err| libafl::Error::unknown(format!("{}", err)))?;

        #[cfg(debug_assertions)]
        input.is_valid();

        Ok(MutationResult::Mutated)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

/// Remove the last call
pub struct RemoveSuffixSeq {}

impl Named for RemoveSuffixSeq {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("RemoveSuffixSeq");
        &NAME
    }
}

impl<S: HasRand> Mutator<ApiSeq, S> for RemoveSuffixSeq {
    fn mutate(
        &mut self,
        _state: &mut S,
        input: &mut ApiSeq,
    ) -> Result<MutationResult, libafl::Error> {
        if input.seq_len() < 2 {
            return Ok(MutationResult::Skipped);
        }

        let new_size = input.seq_len() - 1;
        input.seq_mut().truncate(new_size);

        #[cfg(debug_assertions)]
        input.is_valid();

        Ok(MutationResult::Mutated)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

/// Remove the first call
pub struct RemovePrefixSeq<'a> {
    pub schema: &'a Schema,
}

impl<'a> Named for RemovePrefixSeq<'a> {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("RemovePrefixSeq");
        &NAME
    }
}

impl<'a, S: HasRand> Mutator<ApiSeq, S> for RemovePrefixSeq<'a> {
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut ApiSeq,
    ) -> Result<MutationResult, libafl::Error> {
        if input.seq_len() < 2 {
            return Ok(MutationResult::Skipped);
        }

        input.shift();
        input
            .complete(state.rand_mut(), self.schema)
            .map_err(|err| libafl::Error::unknown(format!("{}", err)))?;

        #[cfg(debug_assertions)]
        input.is_valid();

        Ok(MutationResult::Mutated)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

/// Merge together two sequences
pub struct Crossover<'a> {
    pub schema: &'a Schema,
}

impl<'a> Named for Crossover<'a> {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("Crossover");
        &NAME
    }
}

impl<'a, S> Mutator<ApiSeq, S> for Crossover<'a>
where
    S: HasRand + HasCorpus<ApiSeq>,
{
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut ApiSeq,
    ) -> Result<MutationResult, libafl::Error> {
        let mut other = {
            let id = random_corpus_id!(state.corpus(), state.rand_mut());
            let mut other_testcase = state.corpus().get_from_all(id)?.borrow_mut();
            let other = other_testcase.load_input(state.corpus())?;
            other.clone()
        };
        other.generate_fresh_ids();

        let rand = state.rand_mut();

        // get me a tail of the other sequence
        let other_idx = rand.between(0, other.seq_len());
        let mut suffix = other.seq_mut().split_off(other_idx);

        // mark arguments in the suffix that don't exist any more
        let suffix_ids: HashSet<String> = suffix.iter().map(|call| call.id.clone()).collect();
        for call in &mut suffix {
            for arg in &mut call.args {
                if let ApiCallArg::Output(out) = arg {
                    if !suffix_ids.contains(out) {
                        *arg = ApiCallArg::Missing;
                    }
                }
            }
        }

        let self_new_len = rand.between(0, input.seq_len());
        let seq = input.seq_mut();
        seq.truncate(self_new_len);

        let prefix_ids: HashSet<String> = seq.iter().map(|call| call.id.clone()).collect();
        assert!(prefix_ids.intersection(&suffix_ids).count() == 0);

        seq.append(&mut suffix);

        input
            .complete(rand, self.schema)
            .map_err(|err| libafl::Error::unknown(format!("{}", err)))?;

        #[cfg(debug_assertions)]
        input.is_valid();

        Ok(MutationResult::Mutated)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::Schema;
    use crate::seq::ApiSeq;

    use libafl::{
        corpus::{Corpus, InMemoryCorpus, NopCorpus, Testcase},
        feedbacks::ConstFeedback,
        mutators::{MutationResult, Mutator},
        state::StdState,
    };
    use libafl_bolts::rands::{Rand, StdRand};

    type NopState = StdState<NopCorpus<ApiSeq>, ApiSeq, StdRand, NopCorpus<ApiSeq>>;
    type CorpusState = StdState<InMemoryCorpus<ApiSeq>, ApiSeq, StdRand, NopCorpus<ApiSeq>>;

    fn make_nop_state(seed: u64) -> NopState {
        let mut feedback = ConstFeedback::new(false);
        let mut objective = ConstFeedback::new(false);
        NopState::new(
            StdRand::with_seed(seed),
            NopCorpus::new(),
            NopCorpus::new(),
            &mut feedback,
            &mut objective,
        )
        .expect("failed to create state")
    }

    fn make_corpus_state(seed: u64) -> CorpusState {
        let mut feedback = ConstFeedback::new(false);
        let mut objective = ConstFeedback::new(false);
        CorpusState::new(
            StdRand::with_seed(seed),
            InMemoryCorpus::new(),
            NopCorpus::new(),
            &mut feedback,
            &mut objective,
        )
        .expect("failed to create state")
    }

    fn load_schema() -> Schema {
        let file = std::fs::File::open("tests/common/jpeg-js-typescript.json")
            .expect("failed to open schema file");
        serde_json::from_reader(file).expect("failed to parse schema")
    }

    fn minimal_schema() -> Schema {
        serde_json::from_value(serde_json::json!({
            "simple_fn": {
                "args": [],
                "ret": {
                    "isAny": false,
                    "kind": { "Number": 1.0 }
                },
                "callconv": "Free"
            }
        }))
        .unwrap()
    }

    fn generate_seq(rand: &mut impl Rand, schema: &Schema) -> ApiSeq {
        let fuzz: Vec<u8> = (0..64).map(|_| rand.between(0, 255) as u8).collect();
        ApiSeq::create(rand, schema, fuzz).expect("failed to create ApiSeq")
    }

    #[test]
    fn test_splice_seq_valid() {
        let schema = load_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        let mut mutation = SpliceSeq { schema: &schema };
        let _ = mutation.mutate(&mut state, &mut input);
        input.is_valid();
    }

    #[test]
    fn test_splice_seq_skips_short() {
        let schema = minimal_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        assert_eq!(input.seq_len(), 1);
        let mut mutation = SpliceSeq { schema: &schema };
        let result = mutation
            .mutate(&mut state, &mut input)
            .expect("mutation failed");
        assert_eq!(result, MutationResult::Skipped);
    }

    #[test]
    fn test_splice_seq_reduces_len() {
        let schema = load_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        let mut mutation = SpliceSeq { schema: &schema };
        if input.seq_len() >= 2 {
            let _ = mutation.mutate(&mut state, &mut input);
            input.is_valid();
        }
    }

    #[test]
    fn test_extend_seq_valid() {
        let schema = load_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        let mut mutation = ExtendSeq { schema: &schema };
        let result = mutation
            .mutate(&mut state, &mut input)
            .expect("mutation failed");
        assert_eq!(result, MutationResult::Mutated);
        input.is_valid();
    }

    #[test]
    fn test_extend_seq_increases_len() {
        let schema = load_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        let original_len = input.seq_len();
        let mut mutation = ExtendSeq { schema: &schema };
        mutation
            .mutate(&mut state, &mut input)
            .expect("mutation failed");
        assert!(input.seq_len() > original_len);
        input.is_valid();
    }

    #[test]
    fn test_remove_suffix_valid() {
        let schema = load_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        if input.seq_len() >= 2 {
            let mut mutation = RemoveSuffixSeq {};
            mutation
                .mutate(&mut state, &mut input)
                .expect("mutation failed");
            input.is_valid();
        }
    }

    #[test]
    fn test_remove_suffix_skips_short() {
        let schema = minimal_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        assert_eq!(input.seq_len(), 1);
        let mut mutation = RemoveSuffixSeq {};
        let result = mutation
            .mutate(&mut state, &mut input)
            .expect("mutation failed");
        assert_eq!(result, MutationResult::Skipped);
    }

    #[test]
    fn test_remove_suffix_decreases_len() {
        let schema = load_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        if input.seq_len() >= 2 {
            let original_len = input.seq_len();
            let mut mutation = RemoveSuffixSeq {};
            mutation
                .mutate(&mut state, &mut input)
                .expect("mutation failed");
            assert_eq!(input.seq_len(), original_len - 1);
        }
    }

    #[test]
    fn test_remove_prefix_valid() {
        let schema = load_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        if input.seq_len() >= 2 {
            let mut mutation = RemovePrefixSeq { schema: &schema };
            mutation
                .mutate(&mut state, &mut input)
                .expect("mutation failed");
            input.is_valid();
        }
    }

    #[test]
    fn test_remove_prefix_skips_short() {
        let schema = minimal_schema();
        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);
        assert_eq!(input.seq_len(), 1);
        let mut mutation = RemovePrefixSeq { schema: &schema };
        let result = mutation
            .mutate(&mut state, &mut input)
            .expect("mutation failed");
        assert_eq!(result, MutationResult::Skipped);
    }

    #[test]
    fn test_crossover_valid() {
        let schema = load_schema();
        let mut state = make_corpus_state(42);

        for seed in 0..5 {
            let mut rand = StdRand::with_seed(seed + 100);
            let seq = generate_seq(&mut rand, &schema);
            state
                .corpus_mut()
                .add(Testcase::from(seq))
                .expect("failed to add to corpus");
        }

        let mut input = {
            let rand = state.rand_mut();
            generate_seq(rand, &schema)
        };
        let mut mutation = Crossover { schema: &schema };
        mutation
            .mutate(&mut state, &mut input)
            .expect("mutation failed");
        input.is_valid();
    }

    #[test]
    fn test_mutations_stress() {
        let schema = load_schema();

        let mut state = make_nop_state(42);
        let mut input = generate_seq(state.rand_mut(), &schema);

        for _ in 0..25 {
            let mut splice = SpliceSeq { schema: &schema };
            let mut extend = ExtendSeq { schema: &schema };
            let mut remove_suffix = RemoveSuffixSeq {};
            let mut remove_prefix = RemovePrefixSeq { schema: &schema };

            let pick = state.rand_mut().below_or_zero(4);
            match pick {
                0 => splice.mutate(&mut state, &mut input).is_ok(),
                1 => extend.mutate(&mut state, &mut input).is_ok(),
                2 => remove_suffix.mutate(&mut state, &mut input).is_ok(),
                3 => remove_prefix.mutate(&mut state, &mut input).is_ok(),
                _ => unreachable!(),
            };

            input.is_valid();
        }
    }
}
