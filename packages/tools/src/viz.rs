// SPDX-License-Identifier: AGPL-3.0-or-later

use clap::{Parser, ValueEnum};
use libafl::inputs::{HasMutatorBytes, Input};
use railcar_graph::{ConstantValue, Graph, HasSchema, Node, NodePayload, ParametricGraph};
use serde::{Deserialize, Serialize};

fn node_label(node: &Node) -> String {
    match &node.payload {
        NodePayload::Api { name, .. } => {
            if node.is_fulfilled() {
                name.clone()
            } else {
                format!("{} (missing inputs)", name)
            }
        }
        NodePayload::Constant { value, .. } => {
            match value {
                ConstantValue::Object(_) => "constant (object)".to_owned(),
                ConstantValue::Array(_) => "constant (array)".to_owned(),
                ConstantValue::String(_) => {
                    // dot does not handle non-ASCII labels well, I'll have to add escape them
                    "constant (string)".to_owned()
                }
                ConstantValue::Null => "null".to_owned(),
                ConstantValue::Undefined => "undefined".to_owned(),
                ConstantValue::Number(num) => num.to_string(),
                ConstantValue::Boolean(b) => b.to_string(),
            }
        }
    }
}

trait ToDot {
    fn to_dot(&self, seed: Option<u64>) -> String;
}

impl ToDot for Graph {
    fn to_dot(&self, _seed: Option<u64>) -> String {
        let mut output = "digraph graphname {\n".to_owned();

        // serialize nodes
        for node in self.nodes.values() {
            let root = if node.id == self.root { "root " } else { "" };
            let label = node_label(node);
            let label = format!("{}{}", root, label);
            let line = format!("  {} [label=\"{}\"];\n", node.id, label);
            output.push_str(line.as_str());
        }

        // serialize edges
        for node in self.nodes.values() {
            for inc in &node.incoming {
                let line = format!(
                    "  {} -> {} [headlabel = \"{}\"]\n",
                    inc.src, node.id, inc.port
                );
                output.push_str(line.as_str());
            }
        }

        output.push_str("}\n");
        output
    }
}

impl ToDot for ParametricGraph {
    fn to_dot(&self, seed: Option<u64>) -> String {
        let graph =
            Graph::create_from_bytes(seed.unwrap(), self.mutator_bytes(), self.schema()).unwrap();
        graph.to_dot(None)
    }
}

#[derive(ValueEnum, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum FuzzerMode {
    Graph,
    Parametric,
}

#[derive(Parser)]
struct Arguments {
    path: String,

    #[arg(long, value_enum, default_value_t = FuzzerMode::Graph)]
    mode: FuzzerMode,

    #[arg(long)]
    seed: Option<u64>,
}

pub fn main() {
    let args = Arguments::parse();

    let dot = match args.mode {
        FuzzerMode::Graph => {
            let graph = Graph::from_file(args.path).unwrap();
            graph.to_dot(args.seed)
        }
        FuzzerMode::Parametric => {
            let graph = ParametricGraph::from_file(args.path).unwrap();
            graph.to_dot(args.seed)
        }
    };

    println!("{}", dot);
}
