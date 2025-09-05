#![expect(clippy::disallowed_types)]

use std::collections::HashMap;
use std::fmt::Write;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::str::{FromStr, Split};
use std::{collections::HashSet, hash::Hasher};

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct SetDiff {
    pub left: usize,
    pub right: usize,
    pub both: usize,
    pub none: usize,
    pub total: usize,
}

impl SetDiff {
    pub fn new<K>(left: &HashSet<K>, right: &HashSet<K>, all: &HashSet<K>) -> Self
    where
        K: Eq + Hash + Clone,
    {
        let all_hit = left.union(right).cloned().collect();
        Self {
            left: left.difference(right).count(),
            right: right.difference(left).count(),
            both: left.intersection(right).count(),
            none: all.difference(&all_hit).count(),
            total: all.len(),
        }
    }

    pub fn merge(a: Self, b: Self) -> Self {
        Self {
            left: a.left + b.left,
            right: a.right + b.right,
            both: a.both + b.both,
            none: a.none + b.none,
            total: a.total + b.total,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct DiffSummary {
    pub files: SetDiff,
    pub lines: SetDiff,
    pub branches: SetDiff,
}

#[derive(Debug, Clone)]
pub struct BranchData {
    line: usize,
    block: usize,
    expr: usize,
    count: usize,
}

impl Hash for BranchData {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        state.write_usize(self.line);
        state.write_usize(self.block);
        state.write_usize(self.expr);
    }
}

impl BranchData {
    pub fn id(&self) -> u64 {
        let mut hasher = std::hash::DefaultHasher::new();
        self.hash(&mut hasher);
        hasher.finish()
    }
}

#[derive(Default, Debug, Clone)]
pub struct FileData {
    name: String,

    branches_found: usize,
    branches_hit: usize,
    branches: Vec<BranchData>,

    /// Quick lookup for branch hits. Keep in sync with self.branches
    branch_map: HashMap<u64, usize>,

    lines_found: usize,
    lines_hit: usize,
    lines: HashMap<usize, usize>,
}

impl FileData {
    pub fn lines(&self) -> &HashMap<usize, usize> {
        &self.lines
    }

    pub fn branch_map(&self) -> &HashMap<u64, usize> {
        &self.branch_map
    }

    pub fn lines_hit(&self) -> HashSet<usize> {
        self.lines
            .iter()
            .filter_map(|(line, count)| if *count > 0 { Some(*line) } else { None })
            .collect()
    }

    pub fn num_lines_hit(&self) -> usize {
        self.lines_hit
    }

    pub fn num_lines_found(&self) -> usize {
        self.lines_found
    }

    pub fn branches_hit(&self) -> HashSet<u64> {
        self.branch_map
            .iter()
            .filter_map(|(id, count)| if *count > 0 { Some(*id) } else { None })
            .collect()
    }

    pub fn num_branches_hit(&self) -> usize {
        self.branches_hit
    }

    pub fn num_branches_found(&self) -> usize {
        self.branches_found
    }

    pub fn merge(&mut self, other: &FileData) {
        // update common ones
        for branch in &mut self.branches {
            if let Some(count) = other.branch_map.get(&branch.id()) {
                if branch.count == 0 && *count > 0 {
                    self.branches_hit += 1;
                }

                branch.count += count;
                *self.branch_map.get_mut(&branch.id()).unwrap() += count;
            }
        }

        // add branches only in others
        for branch in &other.branches {
            let id = branch.id();

            #[expect(clippy::map_entry)]
            if !self.branch_map.contains_key(&id) {
                self.branch_map.insert(id, branch.count);
                self.branches.push(branch.clone());

                self.branches_found += 1;
                if branch.count > 0 {
                    self.branches_hit += 1;
                }
            }
        }

        // update common ones
        for (id, count) in &mut self.lines {
            if let Some(other_count) = other.lines.get(id) {
                if *count == 0 && *other_count > 0 {
                    self.lines_hit += 1;
                }
                *count += other_count;
            }
        }

        // add lines only in others
        for (other_id, other_count) in &other.lines {
            if !self.lines.contains_key(other_id) {
                self.lines.insert(*other_id, *other_count);
                self.lines_found += 1;
                if *other_count > 0 {
                    self.lines_hit += 1;
                }
            }
        }
    }
}

#[derive(Default)]
pub struct Trace {
    files: HashMap<String, FileData>,
}

impl Trace {
    pub fn files(&self) -> &HashMap<String, FileData> {
        &self.files
    }

    pub fn files_hit(&self) -> HashSet<String> {
        self.files
            .iter()
            .filter_map(|(name, file)| {
                if file.lines_hit > 0 || file.branches_hit > 0 {
                    Some(name)
                } else {
                    None
                }
            })
            .cloned()
            .collect()
    }

    pub fn lines_hit(&self, file: &str) -> Result<HashSet<usize>> {
        let data = self
            .files
            .get(file)
            .ok_or(anyhow!("file not in trace: {}", file))?;
        Ok(data.lines_hit())
    }

    pub fn branches_hit(&self, file: &str) -> Result<HashSet<u64>> {
        let data = self
            .files
            .get(file)
            .ok_or(anyhow!("file not in trace: {}", file))?;
        Ok(data.branches_hit())
    }

    pub fn branch_coverage(&self, include: Option<&HashSet<PathBuf>>) -> f64 {
        let mut hit = 0;
        let mut found = 0;
        for (file, data) in &self.files {
            let path = PathBuf::from_str(file.as_str()).unwrap();
            if include.is_none_or(|inc| inc.contains(&path)) {
                hit += data.num_branches_hit();
                found += data.num_branches_found();
            }
        }
        (hit as f64) * 100.0 / (found as f64)
    }

    pub fn line_coverage(&self, include: Option<&HashSet<PathBuf>>) -> f64 {
        let mut hit = 0;
        let mut found = 0;
        for (file, data) in &self.files {
            let path = PathBuf::from_str(file.as_str()).unwrap();
            if include.is_none_or(|inc| inc.contains(&path)) {
                hit += data.num_lines_hit();
                found += data.num_lines_found();
            }
        }
        (hit as f64) * 100.0 / (found as f64)
    }

    pub fn load_file<P>(path: P) -> Result<Self>
    where
        P: AsRef<Path>,
    {
        let contents = std::fs::read_to_string(path)?;

        let mut sfs = 0;
        let mut tns = 0;
        let mut brfs = 0;
        let mut brhs = 0;
        let mut lfs = 0;
        let mut lhs = 0;

        let mut trace = Trace {
            files: HashMap::new(),
        };
        let mut current_file: String = String::default();

        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            if line == "end_of_record" {
                continue;
            }

            let (kind, mut fields) = Self::parse_line(line)?;

            match kind {
                "TN" => tns += 1,

                "SF" => {
                    sfs += 1;
                    let name = fields.next().ok_or(anyhow!("missing filename for SF"))?;
                    let old = trace.files.insert(
                        name.to_string(),
                        FileData {
                            name: name.to_string(),
                            ..FileData::default()
                        },
                    );
                    if old.is_some() {
                        bail!("duplicate file: {}", name);
                    }
                    current_file = name.to_string();
                }

                "BRF" => {
                    brfs += 1;
                    let count = fields
                        .next()
                        .ok_or(anyhow!("missing count for BRF"))?
                        .parse()?;
                    let last = trace
                        .files
                        .get_mut(&current_file)
                        .ok_or(anyhow!("encountered BRF before SF"))?;
                    last.branches_found = count;
                }
                "BRH" => {
                    brhs += 1;
                    let count = fields
                        .next()
                        .ok_or(anyhow!("missing count for BRH"))?
                        .parse()?;
                    let last = trace
                        .files
                        .get_mut(&current_file)
                        .ok_or(anyhow!("encountered BRH before SF"))?;
                    last.branches_hit = count;
                }
                "BRDA" => {
                    let line = fields
                        .next()
                        .ok_or(anyhow!("missing line no for BRDA"))?
                        .parse()?;
                    let block = fields
                        .next()
                        .ok_or(anyhow!("missing block for BRDA"))?
                        .parse()?;
                    let expr = fields
                        .next()
                        .ok_or(anyhow!("missing expression for BRDA"))?
                        .parse()?;
                    let count = fields
                        .next()
                        .ok_or(anyhow!("missing count for BRDA"))?
                        .parse()?;

                    let last = trace
                        .files
                        .get_mut(&current_file)
                        .ok_or(anyhow!("encountered BRDA before SF"))?;
                    let data = BranchData {
                        line,
                        block,
                        expr,
                        count,
                    };
                    let old = last.branch_map.insert(data.id(), count);
                    if old.is_some() {
                        bail!("duplicate BRDA entry:\n  file {}\nline {}", last.name, line);
                    }
                    last.branches.push(data);
                }

                "LF" => {
                    lfs += 1;
                    let count = fields
                        .next()
                        .ok_or(anyhow!("missing count for LF"))?
                        .parse()?;
                    let last = trace
                        .files
                        .get_mut(&current_file)
                        .ok_or(anyhow!("encountered LF before SF"))?;
                    last.lines_found = count;
                }
                "LH" => {
                    lhs += 1;
                    let count = fields
                        .next()
                        .ok_or(anyhow!("missing count for LH"))?
                        .parse()?;
                    let last = trace
                        .files
                        .get_mut(&current_file)
                        .ok_or(anyhow!("encountered LH before SF"))?;
                    last.lines_hit = count;
                }
                "DA" => {
                    let line = fields
                        .next()
                        .ok_or(anyhow!("missing line no for DA"))?
                        .parse()?;
                    let count = fields
                        .next()
                        .ok_or(anyhow!("missing count for DA"))?
                        .parse()?;

                    let last = trace
                        .files
                        .get_mut(&current_file)
                        .ok_or(anyhow!("encountered DA before SF: {}", current_file))?;

                    let old = last.lines.insert(line, count);
                    if old.is_some() {
                        bail!("duplicate DA entry:\n  file {}\nline {}", last.name, line);
                    }
                }

                "FN" | "FNF" | "FNH" | "FNDA" => {} // don't need these
                _ => bail!("unknown statement kind {}", kind),
            };
        }

        assert_eq!(tns, sfs);
        assert_eq!(brfs, sfs);
        assert_eq!(brhs, sfs);
        assert_eq!(lfs, sfs);
        assert_eq!(lhs, sfs);

        assert!(trace.files.values().all(|file| {
            (file.branches.len() == file.branch_map.len())
                && (file.lines_found == file.lines.len())
                && (file.lines_hit <= file.lines_found)
                && (file.branches_found == file.branches.len())
                && (file.branches_hit <= file.branches_found)
        }));

        Ok(trace)
    }

    fn parse_line(line: &str) -> Result<(&str, Split<'_, &str>)> {
        let (kind, body) = line
            .split_once(":")
            .ok_or(anyhow!("expected a `:` in line: {}", line))?;
        Ok((kind, body.split(",")))
    }

    pub fn merge(&mut self, other: &Trace) {
        // merge common files
        for (file, data) in &mut self.files {
            if let Some(other_data) = other.files.get(file) {
                data.merge(other_data);
            }
        }

        // add files only in other
        for (file, data) in &other.files {
            if !self.files.contains_key(file) {
                self.files.insert(file.clone(), data.clone());
            }
        }
    }

    pub fn to_lcov_string(&self) -> Result<String> {
        let mut string = String::new();

        for (file, file_data) in &self.files {
            writeln!(string, "TN:")?;
            writeln!(string, "SF:{}", file)?;

            for (id, count) in &file_data.lines {
                writeln!(string, "DA:{},{}", id, count)?;
            }
            writeln!(string, "LF:{}", file_data.lines_found)?;
            writeln!(string, "LH:{}", file_data.lines_hit)?;

            for branch in &file_data.branches {
                let BranchData {
                    line,
                    block,
                    expr,
                    count,
                } = branch;
                writeln!(string, "BRDA:{},{},{},{}", line, block, expr, count)?;
            }
            writeln!(string, "BRF:{}", file_data.branches_found)?;
            writeln!(string, "BRH:{}", file_data.branches_hit)?;

            writeln!(string, "end_of_record")?;
        }

        Ok(string)
    }
}
