use anyhow::Result;
use libafl_bolts::shmem::{ShMem, UnixShMem};

/// Size of the coverage map
const COVERAGE_MAP_SIZE: usize = 1 << 15;

#[repr(C)]
pub struct ShMemView {
    pub total_edges: u32,
    pub is_valid: bool,
    pub num_calls_executed: u32,
    pub coverage: [u8; COVERAGE_MAP_SIZE],
}

impl ShMemView {
    pub fn alloc() -> Result<UnixShMem> {
        const SIZE: usize = std::mem::size_of::<ShMemView>();
        let shmem = UnixShMem::new(SIZE)?;

        // NOTE: mark this for deletion once all processes detach from it.
        // this shmem segment should have at most two attachments: the current
        // client and the node child. the node child will only try to attach to
        // this segment while the fuzzer client is attached, so it is safe to call
        // shmctl(IPC_RMID) *BEFORE* node has had the chance to attach to it.
        //
        // Attaching with shmat after marking for deletion with shmctl is a Linux-specific
        // feature. See https://www.man7.org/linux/man-pages/man2/shmctl.2.html
        let ok = unsafe {
            nix::libc::shmctl(shmem.id().into(), nix::libc::IPC_RMID, std::ptr::null_mut())
        };

        if ok < 0 {
            let errno = nix::errno::Errno::last();
            anyhow::bail!(
                "failed to mark coverage map shmem for deletion. errno {}",
                errno
            )
        }

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

    #[inline]
    pub fn num_calls_executed_ptr(&self) -> *const u32 {
        &self.num_calls_executed
    }
}
