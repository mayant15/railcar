use anyhow::Result;
use libafl::{
    events::{EventConfig, Launcher, SendExiting},
    inputs::BytesInput,
    monitors::Monitor,
};
use libafl_bolts::{
    core_affinity::Cores,
    shmem::{MmapShMemProvider, ShMemProvider},
};
use railcar::{
    inputs::{ApiSeq, Graph, ParametricGraph, ToFuzzerInput},
    FuzzerConfig, FuzzerMode, ReplayRestartingManager, Worker,
};

fn client<I: ToFuzzerInput, SP: ShMemProvider>(
    mut restarting_mgr: ReplayRestartingManager<I, SP>,
    config: &FuzzerConfig,
) -> Result<()> {
    let Some(input_path) = &config.replay_input else {
        log::error!("no input file to replay!");
        restarting_mgr.on_shutdown()?;
        return Ok(());
    };

    let input = I::from_file(input_path)?;
    let bytes = input.to_fuzzer_input(config)?;

    let mut worker = Worker::new(config.into())?;
    if let Err(e) = worker.invoke(&bytes) {
        log::error!("failed to invoke worker: {}", e);
    }
    worker.terminate()?;

    restarting_mgr.on_shutdown()?;
    Ok(())
}

fn launch_impl<I, M>(
    config: FuzzerConfig,
    shmem_provider: MmapShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    I: ToFuzzerInput,
    M: Monitor + Clone,
{
    let mut run_client = |_, restarting_mgr, _| {
        client::<I, _>(restarting_mgr, &config).map_err(|e| libafl::Error::unknown(e.to_string()))
    };

    Launcher::builder()
        .configuration(EventConfig::from_name("default"))
        .shmem_provider(shmem_provider)
        .monitor(monitor)
        .cores(&cores)
        .run_client(&mut run_client)
        .broker_port(config.port)
        .build()
        .launch()?;

    Ok(())
}

pub fn launch<M>(
    config: FuzzerConfig,
    shmem_provider: MmapShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    M: Monitor + Clone,
{
    match config.mode {
        FuzzerMode::Bytes => launch_impl::<BytesInput, _>(config, shmem_provider, monitor, cores),
        FuzzerMode::Graph => launch_impl::<Graph, _>(config, shmem_provider, monitor, cores),
        FuzzerMode::Parametric => {
            launch_impl::<ParametricGraph, _>(config, shmem_provider, monitor, cores)
        }
        FuzzerMode::Sequence => launch_impl::<ApiSeq, _>(config, shmem_provider, monitor, cores),
    }
}
