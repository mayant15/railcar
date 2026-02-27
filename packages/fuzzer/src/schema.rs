use anyhow::{anyhow, Result};
use libafl_bolts::rands::Rand;

use std::collections::{btree_map, BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::rng::{Distribution, TrySample};

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
        let choice = rand.between(0, 7);
        let kind = TypeKind::try_from(choice)?;

        match kind {
            TypeKind::Number => Ok(Type::Number),
            TypeKind::String => Ok(Type::String),
            TypeKind::Boolean => Ok(Type::Boolean),
            TypeKind::Undefined => Ok(Type::Undefined),
            TypeKind::Null => Ok(Type::Null),
            TypeKind::Object => Ok(Type::Object(BTreeMap::new())),
            TypeKind::Class => Ok(Type::Class("Uint8Array".to_owned())),
            TypeKind::Array => Ok(Type::Array(Box::new(Type::Number))),
            TypeKind::Function => Ok(Type::Function),
        }
    }
}

impl<R: Rand> TrySample<Type, R> for TypeGuess {
    fn sample(&self, rand: &mut R) -> Result<Type> {
        if self.is_any {
            return TypeGuess::sample_any_type(rand);
        }

        match self.kind.sample(rand)? {
            TypeKind::Undefined => Ok(Type::Undefined),
            TypeKind::Number => Ok(Type::Number),
            TypeKind::String => Ok(Type::String),
            TypeKind::Boolean => Ok(Type::Boolean),
            TypeKind::Null => Ok(Type::Null),
            TypeKind::Function => Ok(Type::Function),

            TypeKind::Object => {
                if let Some(shape) = &self.object_shape {
                    let mut props = BTreeMap::new();
                    for (key, guess) in shape {
                        props.insert(key.clone(), guess.sample(rand)?);
                    }
                    Ok(Type::Object(props))
                } else {
                    panic!("guess should have object shape if it can be an object")
                }
            }

            TypeKind::Class => {
                if let Some(distrib) = &self.class_type {
                    Ok(Type::Class(distrib.sample(rand)?))
                } else {
                    panic!("guess should have class name if it can be a class")
                }
            }

            TypeKind::Array => {
                if let Some(guess) = &self.array_value_type {
                    Ok(Type::Array(Box::new(guess.sample(rand)?)))
                } else {
                    panic!("guess should have array type if it can be an array")
                }
            }
        }
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
