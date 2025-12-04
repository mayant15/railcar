use std::{borrow::Cow, collections::HashSet};

use libafl::{
    corpus::{Corpus, CorpusId},
    mutators::{
        havoc_mutations, HavocMutationsType, HavocScheduledMutator, MutationResult, Mutator,
    },
    random_corpus_id_with_disabled,
    state::{HasCorpus, HasRand},
};
use libafl_bolts::{
    rands::Rand,
    tuples::{tuple_list, tuple_list_type},
    Named,
};

use crate::{
    inputs::HasSeqLen,
    schema::Schema,
    seq::input::{ApiCallArg, ApiSeq},
};

#[cfg(debug_assertions)]
use crate::inputs::CanValidate;

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
    schema: &'a Schema,
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
    schema: &'a Schema,
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
            let id = random_corpus_id_with_disabled!(state.corpus(), state.rand_mut());
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
