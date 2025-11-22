use std::borrow::Cow;

use libafl::observers::{HitcountsMapObserver, Observer, StdMapObserver};
use libafl_bolts::{
    shmem::ShMem,
    tuples::{tuple_list, tuple_list_type},
    Named,
};
use railcar_graph::shmem::ShMemView;
use serde::{Deserialize, Serialize};

pub type Observers = tuple_list_type!(CoverageObserver, ValidityObserver, TotalEdgesObserver);
pub type CoverageObserver = HitcountsMapObserver<StdMapObserver<'static, u8, false>>;
pub type TotalEdgesObserver = ReadOnlyPointerObserver<u32>;

pub fn make_observers<S>(shmem: &mut S) -> Observers
where
    S: ShMem,
{
    let data = ShMemView::from_mut(shmem);
    tuple_list!(
        HitcountsMapObserver::new(unsafe {
            let map = data.coverage_mut();
            StdMapObserver::from_mut_ptr("CodeCoverage", map.as_mut_ptr(), map.len())
        }),
        ValidityObserver::new(data.is_valid_ptr()),
        TotalEdgesObserver::new("TotalEdges", data.total_edges_ptr()),
    )
}

// TODO: Why does this need to be serializable?
#[derive(Serialize, Deserialize)]
pub struct ValidityObserver {
    #[serde(skip)]
    ptr: *mut bool,
}

impl ValidityObserver {
    #[inline]
    pub fn new(ptr: *mut bool) -> Self {
        Self { ptr }
    }

    #[inline]
    pub fn is_valid(&self) -> bool {
        unsafe { *self.ptr }
    }

    #[inline]
    pub fn set_is_valid(&mut self, val: bool) {
        unsafe { *self.ptr = val };
    }
}

impl Named for ValidityObserver {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("IsValidInput");
        &NAME
    }
}

impl<I, S> Observer<I, S> for ValidityObserver {
    fn pre_exec(&mut self, _state: &mut S, _input: &I) -> Result<(), libafl::Error> {
        // assume an input is valid unless we learn otherwise
        unsafe { *self.ptr = true };
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
pub struct ReadOnlyPointerObserver<T> {
    name: Cow<'static, str>,
    #[serde(skip)]
    ptr: *const T,
}

impl<T> ReadOnlyPointerObserver<T> {
    pub fn new(name: &'static str, ptr: *const T) -> Self {
        Self {
            ptr,
            name: Cow::from(name),
        }
    }

    pub fn value(&self) -> &T {
        unsafe { &*self.ptr }
    }
}

impl<T> Named for ReadOnlyPointerObserver<T> {
    fn name(&self) -> &Cow<'static, str> {
        &self.name
    }
}

impl<T, I, S> Observer<I, S> for ReadOnlyPointerObserver<T> {}
