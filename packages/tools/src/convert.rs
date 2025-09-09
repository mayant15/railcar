// SPDX-License-Identifier: AGPL-3.0-or-later

use clap::Parser;
use railcar_graph::Graph;

#[derive(Parser)]
struct Arguments {
    output: Option<String>,

    #[arg(long, value_name = "FILE")]
    json: Option<String>,

    #[arg(long, value_name = "FILE")]
    msgpack: Option<String>,
}

pub fn main() -> anyhow::Result<()> {
    let args = Arguments::parse();

    if args.json.is_some() && args.msgpack.is_some() {
        panic!("pick one input format");
    }

    if let Some(path) = args.json {
        let file = std::fs::File::open(&path)?;
        let graph: Graph = serde_json::from_reader(file)?;
        let msgpack = rmp_serde::to_vec_named(&graph)?;
        if let Some(output) = args.output {
            std::fs::write(output, msgpack)?;
        } else {
            panic!("cannot output msgpack to stdout");
        }
    } else if let Some(path) = args.msgpack {
        let file = std::fs::File::open(&path)?;
        let graph: Graph = rmp_serde::from_read(file)?;
        let json = serde_json::to_string_pretty(&graph)?;
        if let Some(output) = args.output {
            std::fs::write(output, json)?;
        } else {
            println!("{}", json);
        }
    } else {
        panic!("no input provided");
    }

    Ok(())
}
