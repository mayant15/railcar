use anyhow::Result;
use libafl_bolts::shmem::{ShMem, ShMemProvider};

use crate::config::COVERAGE_MAP_SIZE;

#[repr(C)]
pub struct ShMemView {
    pub total_edges: u32,
    pub is_valid: bool,
    pub coverage: [u8; COVERAGE_MAP_SIZE],
}

impl ShMemView {
    #[inline]
    pub fn alloc<SP: ShMemProvider>(provider: &mut SP) -> Result<SP::ShMem> {
        const SIZE: usize = std::mem::size_of::<ShMemView>();
        let shmem = provider.new_shmem(SIZE)?;
        Ok(shmem)
    }

    #[inline]
    pub fn from<S: ShMem>(shmem: &S) -> &ShMemView {
        unsafe { &*shmem.as_ptr().cast() }
    }

    #[inline]
    pub fn from_mut<S: ShMem>(shmem: &mut S) -> &mut ShMemView {
        unsafe { &mut *shmem.as_mut_ptr().cast() }
    }

    #[inline]
    pub fn coverage_mut(&mut self) -> &mut [u8] {
        self.coverage.as_mut_slice()
    }

    #[inline]
    pub fn is_valid_ptr(&mut self) -> *mut bool {
        &mut self.is_valid
    }

    #[inline]
    pub fn total_edges_ptr(&self) -> *const u32 {
        &self.total_edges
    }
}
