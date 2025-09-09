// SPDX-License-Identifier: AGPL-3.0-or-later

use libafl_bolts::shmem::{MmapShMem, MmapShMemProvider, ShMemDescription, ShMemProvider};
use napi::{Env, JsNumber, JsObject};

#[macro_use]
extern crate napi_derive;

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
    pub fn record_hit(&mut self, key: JsNumber) -> napi::Result<()> {
        let key: usize = key.get_uint32()?.try_into().map_err(|e| {
            napi::Error::from_reason(format!("failed to convert u32 -> usize {}", e))
        })?;
        let key = key % self.shmem.len();
        let hits = self.shmem[key];
        let hits = if hits == 255 { 1 } else { hits + 1 };
        self.shmem[key] = hits;
        Ok(())
    }
}
