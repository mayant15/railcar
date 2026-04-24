use anyhow::{anyhow, bail, Result};
use libafl_bolts::rands::Rand;

use std::collections::{btree_map, BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::rng::{redistribute, Distribution, TrySample};

pub type EndpointName = String;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Schema(BTreeMap<EndpointName, SignatureGuess>);

impl Schema {
    pub fn keys(&self) -> btree_map::Keys<'_, String, SignatureGuess> {
        self.0.keys()
    }

    pub fn get(&self, key: &EndpointName) -> Option<&SignatureGuess> {
        self.0.get(key)
    }

    pub fn iter(&self) -> btree_map::Iter<'_, String, SignatureGuess> {
        self.0.iter()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Hash, Eq, PartialEq)]
pub enum TypeKind {
    Number,
    String,
    Boolean,
    Object,
    Class,
    Array,
    Undefined,
    Null,
    Function,
}

impl PartialOrd for TypeKind {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for TypeKind {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let self_int = *self as isize;
        let other_int = *other as isize;
        self_int.cmp(&other_int)
    }
}

impl TypeKind {
    pub fn kinds() -> Vec<TypeKind> {
        vec![
            TypeKind::Number,
            TypeKind::String,
            TypeKind::Boolean,
            TypeKind::Object,
            TypeKind::Class,
            TypeKind::Array,
            TypeKind::Undefined,
            TypeKind::Null,
        ]
    }
}

impl TryFrom<usize> for TypeKind {
    type Error = anyhow::Error;

    fn try_from(value: usize) -> Result<Self, Self::Error> {
        match value {
            value if value == TypeKind::Number as usize => Ok(TypeKind::Number),
            value if value == TypeKind::String as usize => Ok(TypeKind::String),
            value if value == TypeKind::Boolean as usize => Ok(TypeKind::Boolean),
            value if value == TypeKind::Object as usize => Ok(TypeKind::Object),
            value if value == TypeKind::Class as usize => Ok(TypeKind::Class),
            value if value == TypeKind::Array as usize => Ok(TypeKind::Array),
            value if value == TypeKind::Undefined as usize => Ok(TypeKind::Undefined),
            value if value == TypeKind::Null as usize => Ok(TypeKind::Null),
            _ => Err(anyhow!("invalid number for TypeKind")),
        }
    }
}

impl From<&Type> for TypeKind {
    fn from(value: &Type) -> Self {
        match value {
            Type::Number => TypeKind::Number,
            Type::String => TypeKind::String,
            Type::Boolean => TypeKind::Boolean,
            Type::Object(_) => TypeKind::Object,
            Type::Class(_) => TypeKind::Class,
            Type::Array(_) => TypeKind::Array,
            Type::Undefined => TypeKind::Undefined,
            Type::Null => TypeKind::Null,
            Type::Function => TypeKind::Function,
        }
    }
}

type ObjectShape = BTreeMap<String, Type>;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Type {
    Number,
    String,
    Boolean,
    Object(ObjectShape),
    Class(EndpointName),
    Array(Box<Type>),
    Undefined,
    Null,
    Function,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TypeGuess {
    pub is_any: bool,
    pub kind: Distribution<TypeKind>,
    pub object_shape: Option<BTreeMap<String, TypeGuess>>,
    pub array_value_type: Option<Box<TypeGuess>>,
    pub class_type: Option<Distribution<EndpointName>>,
}

impl TypeGuess {
    pub fn any() -> TypeGuess {
        TypeGuess {
            is_any: true,
            ..Default::default()
        }
    }

    pub fn overlaps(&self, other: &TypeGuess) -> bool {
        if self.is_any || other.is_any {
            return true;
        }

        let mine: HashSet<&TypeKind> = self.kind.keys().collect();
        let theirs: HashSet<&TypeKind> = other.kind.keys().collect();
        mine.intersection(&theirs).count() > 0
    }

    fn sample_any_type<R: Rand>(rand: &mut R) -> Result<Type> {
        let Some(typ) = rand.choose([
            Type::Number,
            Type::String,
            Type::Boolean,
            Type::Undefined,
            Type::Null,
            Type::Object(BTreeMap::new()),
            Type::Array(Box::new(Type::Number)), // TODO: this allocation is sad but oh well...
            Type::Function,
        ]) else {
            bail!("failed to sample any type")
        };
        Ok(typ)
    }

    pub fn sample_const_type<R: Rand>(&self, rand: &mut R) -> Result<Type> {
        if self.is_any {
            return Self::sample_any_type(rand);
        }

        if self.is_only_class() {
            // TODO: should we bail in this case instead of passing null?
            return Ok(Type::Null);
        }

        let guess = self.strip_class(rand);

        match guess.kind.sample(rand)? {
            TypeKind::Undefined => Ok(Type::Undefined),
            TypeKind::Number => Ok(Type::Number),
            TypeKind::String => Ok(Type::String),
            TypeKind::Boolean => Ok(Type::Boolean),
            TypeKind::Null => Ok(Type::Null),
            TypeKind::Function => Ok(Type::Function),

            TypeKind::Object => {
                if let Some(shape) = guess.object_shape {
                    let mut props = BTreeMap::new();
                    for (key, guess) in shape {
                        props.insert(key.clone(), guess.sample_const_type(rand)?);
                    }
                    Ok(Type::Object(props))
                } else {
                    bail!("guess should have object shape if it can be an object")
                }
            }

            TypeKind::Array => {
                if let Some(guess) = guess.array_value_type {
                    Ok(Type::Array(Box::new(guess.sample_const_type(rand)?)))
                } else {
                    bail!("guess should have array type if it can be an array")
                }
            }

            TypeKind::Class => {
                unreachable!("classes should be stripped before constant sampling")
            }
        }
    }

    pub fn is_only_class(&self) -> bool {
        self.kind.len() == 1 && self.kind.contains_key(&TypeKind::Class)
    }

    fn strip_class<R: Rand>(&self, rand: &mut R) -> TypeGuess {
        let mut clone = self.clone();
        clone.kind.remove(&TypeKind::Class);
        clone.class_type = None;
        redistribute(rand, &mut clone.kind);
        clone
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Eq, PartialEq, Copy)]
pub enum CallConvention {
    Free,
    Method,
    Constructor,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SignatureGuess {
    pub args: Vec<TypeGuess>,
    pub ret: TypeGuess,
    pub callconv: CallConvention,
    pub builtin: Option<bool>,
}

pub trait HasSchema {
    fn schema(&self) -> &Schema;
    fn schema_mut(&mut self) -> &mut Schema;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number_guess() -> TypeGuess {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Number, 1.0);
        TypeGuess {
            is_any: false,
            kind,
            ..Default::default()
        }
    }

    fn string_guess() -> TypeGuess {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::String, 1.0);
        TypeGuess {
            is_any: false,
            kind,
            ..Default::default()
        }
    }

    #[test]
    fn test_overlaps_same_kind() {
        let a = number_guess();
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Number, 0.5);
        kind.insert(TypeKind::String, 0.5);
        let b = TypeGuess {
            is_any: false,
            kind,
            ..Default::default()
        };
        assert!(a.overlaps(&b));
    }

    #[test]
    fn test_overlaps_disjoint() {
        let a = number_guess();
        let b = string_guess();
        assert!(!a.overlaps(&b));
    }

    #[test]
    fn test_overlaps_any() {
        let a = TypeGuess::any();
        let b = number_guess();
        assert!(a.overlaps(&b));
        assert!(b.overlaps(&a));
    }
}
