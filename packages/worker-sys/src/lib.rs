// SPDX-License-Identifier: AGPL-3.0-or-later

use libafl_bolts::shmem::{MmapShMem, MmapShMemProvider, ShMemDescription, ShMemProvider};
use napi::{Env, JsNumber, JsObject};

#[macro_use]
extern crate napi_derive;

#[inline]
fn get_total_mut_ptr(shmem: &mut MmapShMem) -> *mut u32 {
    shmem.as_mut_ptr().cast::<u32>()
}

#[inline]
fn get_map_mut_slice(shmem: &mut MmapShMem) -> &mut [u8] {
    &mut shmem[5..]
}

#[inline]
fn get_valid_mut_ptr(shmem: &mut MmapShMem) -> &mut u8 {
    &mut shmem[4]
}

#[napi]
pub struct CoverageMap {
    shmem: MmapShMem,
}

#[napi]
impl CoverageMap {
    #[napi(constructor)]
    pub fn new(env: Env, desc: JsObject) -> napi::Result<Self> {
        let desc: ShMemDescription = env.from_js_value(desc).unwrap();
        let mut provider = MmapShMemProvider::new().unwrap();
        let shmem = provider.shmem_from_description(desc).unwrap();
        Ok(Self { shmem })
    }

    #[napi]
    pub fn record_hit(&mut self, edge_id: JsNumber, total: JsNumber) -> napi::Result<()> {
        let total = total.get_uint32()?;
        let edge_id: usize = edge_id.get_uint32()?.try_into().map_err(|e| {
            napi::Error::from_reason(format!("failed to convert u32 -> usize {}", e))
        })?;

        // set total
        unsafe { *get_total_mut_ptr(&mut self.shmem) = total };

        // set count
        let map = get_map_mut_slice(&mut self.shmem);
        let key = edge_id % map.len();
        let hits = map[key];
        let hits = if hits == 255 { 1 } else { hits + 1 };
        map[key] = hits;

        Ok(())
    }

    #[napi]
    pub fn set_valid(&mut self, is_valid: bool) {
        *get_valid_mut_ptr(&mut self.shmem) = if is_valid { 1 } else { 0 };
    }
}
