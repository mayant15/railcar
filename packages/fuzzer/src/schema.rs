use anyhow::{anyhow, Result};

#[expect(clippy::disallowed_types)]
use std::collections::{btree_map, BTreeMap, HashMap, HashSet};

use libafl_bolts::rands::Rand;
use serde::{Deserialize, Serialize};

use crate::{
    config::ENABLE_LIKELIHOOD_BASED_CONCRETIZATION,
    rng::{self, Distribution, TrySample},
};

pub type EndpointName = String;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum ConstantValue {
    Number(f64),
    String(String),
    Boolean(bool),
    Object(BTreeMap<String, ConstantValue>),
    Array(Vec<ConstantValue>),
    Undefined,
    Null,
    Function,
}

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

    pub fn get_mut(&mut self, key: &EndpointName) -> Option<&mut SignatureGuess> {
        self.0.get_mut(key)
    }

    pub fn iter(&self) -> btree_map::Iter<'_, String, SignatureGuess> {
        self.0.iter()
    }

    pub fn classes(&self) -> Vec<EndpointName> {
        self.0
            .iter()
            .filter_map(|(name, guess)| {
                if matches!(guess.callconv, CallConvention::Constructor) {
                    Some(name.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn concretize<R: Rand>(
        &self,
        rand: &mut R,
        query: SignatureQuery,
    ) -> Option<(EndpointName, Signature, Option<Vec<usize>>)> {
        let candidates = self.filter(&query);

        if candidates.is_empty() {
            return None;
        }

        let (name, signature, ports) = if ENABLE_LIKELIHOOD_BASED_CONCRETIZATION {
            Self::pick_candidate(rand, &query, &candidates)
        } else {
            rand.choose(&candidates).unwrap()
        };
        let name = name.to_string();
        let Ok(signature) = Self::patch(rand, &query, signature, ports) else {
            // TODO: do I need to propagate this error up?
            return None;
        };

        Some((name, signature, ports.clone()))
    }

    fn pick_candidate<'a, 'b, R: Rand>(
        rand: &mut R,
        query: &SignatureQuery,
        candidates: &'a [(&'b String, &'b SignatureGuess, Option<Vec<usize>>)],
    ) -> &'a (&'b String, &'b SignatureGuess, Option<Vec<usize>>) {
        let mut likelihoods: Distribution<usize> = candidates
            .iter()
            .enumerate()
            .map(|(idx, candidate)| (idx, Self::compute_likelihood(query, candidate)))
            .collect();

        Self::normalize(&mut likelihoods);

        let idx = likelihoods.sample(rand).unwrap();
        &candidates[idx]
    }

    fn normalize<K>(dist: &mut Distribution<K>) {
        let total: f64 = dist.values().sum();
        for value in dist.values_mut() {
            *value /= total;
        }
    }

    fn compute_likelihood(
        query: &SignatureQuery,
        candidate: &(&String, &SignatureGuess, Option<Vec<usize>>),
    ) -> f64 {
        let (_, guess, ports) = candidate;
        let mut likelihood = 1.0;

        if let Some(ret) = &query.ret {
            likelihood *= guess.ret.probability_of(ret);
        }

        if let Some(args) = &query.args {
            assert!(ports.is_some());
            let ports = ports.as_ref().unwrap();
            for (idx, arg) in args.iter().enumerate() {
                likelihood *= guess.args[ports[idx]].probability_of(arg)
            }
        }

        likelihood
    }

    fn filter<'a>(
        &'a self,
        query: &SignatureQuery,
    ) -> Vec<(&'a EndpointName, &'a SignatureGuess, Option<Vec<usize>>)> {
        self.0
            .iter()
            .filter(|(_, sig)| {
                // by return type
                let Some(ret) = &query.ret else { return true };
                sig.ret.can_guess(ret)
            })
            .filter(|(_, sig)| {
                // by calling convention
                let Some(cc) = &query.callconv else {
                    return true;
                };
                &sig.callconv == cc
            })
            .filter_map(|(name, sig)| {
                // by args
                let Some(args) = &query.args else {
                    return Some((name, sig, None));
                };
                sig.can_receive(args).map(|ports| (name, sig, Some(ports)))
            })
            .collect()
    }

    /// Construct a concrete signature from a SignatureGuess that satisfies the query.
    /// `query_args_to_ports` parameter is the list of ports where each query.args goes
    fn patch<R: Rand>(
        rand: &mut R,
        query: &SignatureQuery,
        guess: &SignatureGuess,
        query_args_to_ports: &Option<Vec<usize>>,
    ) -> Result<Signature> {
        debug_assert!(
            {
                if let Some(callconv) = &query.callconv {
                    *callconv == guess.callconv
                } else {
                    true
                }
            },
            "concretized guess does not match query callconv"
        );

        let mut sig = Signature {
            args: vec![Type::Undefined; guess.args.len()],
            ret: Type::Undefined,
            callconv: guess.callconv,
        };

        if let Some(ret) = &query.ret {
            debug_assert!(
                guess.ret.can_guess(ret),
                "concretized guess cannot return the queried return type"
            );
            sig.ret = ret.clone();
        } else {
            sig.ret = guess.ret.sample(rand)?;
        }

        if let Some(args) = &query.args {
            assert!(
                query_args_to_ports.is_some(),
                "concretization queries over arguments must propagate ports mapping"
            );

            #[expect(clippy::disallowed_types)]
            let ports_to_query_args: HashMap<usize, usize> = query_args_to_ports
                .as_ref()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(arg, port)| (*port, arg))
                .collect();

            for (port, typ) in sig.args.iter_mut().enumerate() {
                if let Some(arg_idx) = ports_to_query_args.get(&port) {
                    *typ = args[*arg_idx].clone();
                } else {
                    *typ = guess.args[port].sample(rand)?;
                }
            }
        } else {
            let args: Result<Vec<Type>, _> =
                guess.args.iter().map(|arg| arg.sample(rand)).collect();
            sig.args = args?;
        }

        Ok(sig)
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

#[derive(Serialize, Deserialize, Debug, Clone, Eq, PartialEq, Hash)]
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

impl<R: Rand> TrySample<ConstantValue, R> for Type {
    fn sample(&self, rand: &mut R) -> Result<ConstantValue> {
        match self {
            Type::Number => Ok(ConstantValue::Number(rng::float(rand))),
            Type::String => Ok(ConstantValue::String(rng::string(rand))),
            Type::Boolean => Ok(ConstantValue::Boolean(rng::boolean(rand))),

            Type::Object(shape) => {
                let mut props = BTreeMap::new();
                for (name, typ) in shape {
                    if matches!(typ, Type::Class(_)) {
                        props.insert(name.clone(), ConstantValue::Null);
                    } else {
                        props.insert(name.clone(), typ.sample(rand)?);
                    }
                }
                Ok(ConstantValue::Object(props))
            }

            Type::Array(typ) => {
                let size = rng::size(rand);
                let mut vec = Vec::with_capacity(size);
                for _ in 0..size {
                    if matches!(**typ, Type::Class(_)) {
                        vec.push(ConstantValue::Null)
                    } else {
                        vec.push(typ.sample(rand)?)
                    }
                }
                Ok(ConstantValue::Array(vec))
            }

            Type::Undefined => Ok(ConstantValue::Undefined),
            Type::Null => Ok(ConstantValue::Null),
            Type::Function => Ok(ConstantValue::Function),
            Type::Class(_) => Err("cannot construct classes"),
        }
        .map_err(|e| anyhow!("failed to serialize to ConstantValue {e}"))
    }
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
    pub fn any() -> Self {
        Self {
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

    pub fn can_guess(&self, typ: &Type) -> bool {
        if self.is_any {
            return true;
        }

        let kind: TypeKind = typ.into();
        if !self.kind.contains_key(&kind) {
            return false;
        }

        match typ {
            Type::Class(cls) => {
                let Some(dist) = &self.class_type else {
                    panic!("classes should have a class map");
                };
                dist.contains_key(cls)
            }
            Type::Object(obj) => {
                let Some(fields) = &self.object_shape else {
                    panic!("objects should have a props map");
                };
                obj.keys()
                    .all(|key| fields.contains_key(key) && fields[key].can_guess(&obj[key]))
            }
            Type::Array(arr) => {
                let Some(value_type) = &self.array_value_type else {
                    panic!("arrays should have a value type guess");
                };
                value_type.can_guess(arr)
            }
            _ => true,
        }
    }

    pub fn probability_of(&self, typ: &Type) -> f64 {
        if self.is_any {
            return 1.0;
        }

        if !self.can_guess(typ) {
            return 0.0;
        }

        let kind: TypeKind = typ.into();
        self.kind[&kind]
    }
}

impl<R: Rand> TrySample<Type, R> for TypeGuess {
    fn sample(&self, rand: &mut R) -> Result<Type> {
        if self.is_any {
            return TypeGuess::any_type(rand);
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

impl TypeGuess {
    fn any_type<R: Rand>(rand: &mut R) -> Result<Type> {
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

impl SignatureGuess {
    fn can_receive(&self, args: &[Type]) -> Option<Vec<usize>> {
        let mut used = HashSet::new();
        let mut ports = vec![0; args.len()];
        for (idx, arg) in args.iter().enumerate() {
            let Some(port) = self.args.iter().enumerate().find_map(|(port, guess)| {
                if !used.contains(&port) && guess.can_guess(arg) {
                    Some(port)
                } else {
                    None
                }
            }) else {
                // this argument cannot fit in any port
                return None;
            };
            ports[idx] = port;
            used.insert(port);
        }
        Some(ports)
    }
}

impl<R: Rand> TrySample<Signature, R> for SignatureGuess {
    fn sample(&self, rand: &mut R) -> Result<Signature> {
        let mut args = Vec::with_capacity(self.args.len());
        for arg in &self.args {
            args.push(arg.sample(rand)?);
        }

        Ok(Signature {
            args,
            ret: self.ret.sample(rand)?,
            callconv: self.callconv,
        })
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Signature {
    pub args: Vec<Type>,
    pub ret: Type,
    pub callconv: CallConvention,
}

impl Signature {
    pub fn find_port(&self, typ: &Type) -> Option<usize> {
        self.args.iter().enumerate().find_map(
            |(idx, arg)| {
                if arg == typ {
                    Some(idx)
                } else {
                    None
                }
            },
        )
    }
}

#[derive(Debug)]
pub struct SignatureQuery {
    pub args: Option<Vec<Type>>,
    pub ret: Option<Type>,
    pub callconv: Option<CallConvention>,
}

pub trait HasSchema {
    fn schema(&self) -> &Schema;
    fn schema_mut(&mut self) -> &mut Schema;
}

#[cfg(test)]
mod tests {
    use super::*;
    use libafl_bolts::rands::StdRand;

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

    fn boolean_guess() -> TypeGuess {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Boolean, 1.0);
        TypeGuess {
            is_any: false,
            kind,
            ..Default::default()
        }
    }

    fn undefined_guess() -> TypeGuess {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Undefined, 1.0);
        TypeGuess {
            is_any: false,
            kind,
            ..Default::default()
        }
    }

    fn null_guess() -> TypeGuess {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Null, 1.0);
        TypeGuess {
            is_any: false,
            kind,
            ..Default::default()
        }
    }

    fn function_guess() -> TypeGuess {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Function, 1.0);
        TypeGuess {
            is_any: false,
            kind,
            ..Default::default()
        }
    }

    fn make_schema(entries: Vec<(&str, SignatureGuess)>) -> Schema {
        let map: BTreeMap<EndpointName, SignatureGuess> = entries
            .into_iter()
            .map(|(name, guess)| (name.to_string(), guess))
            .collect();
        Schema(map)
    }

    #[test]
    fn test_can_guess_simple_types() {
        let ng = number_guess();
        assert!(ng.can_guess(&Type::Number));
        assert!(!ng.can_guess(&Type::String));

        let sg = string_guess();
        assert!(sg.can_guess(&Type::String));
        assert!(!sg.can_guess(&Type::Number));

        let bg = boolean_guess();
        assert!(bg.can_guess(&Type::Boolean));
        assert!(!bg.can_guess(&Type::Number));

        let ug = undefined_guess();
        assert!(ug.can_guess(&Type::Undefined));
        assert!(!ug.can_guess(&Type::Number));

        let nlg = null_guess();
        assert!(nlg.can_guess(&Type::Null));
        assert!(!nlg.can_guess(&Type::String));

        let fg = function_guess();
        assert!(fg.can_guess(&Type::Function));
        assert!(!fg.can_guess(&Type::Number));
    }

    #[test]
    fn test_can_guess_any() {
        let guess = TypeGuess::any();
        assert!(guess.can_guess(&Type::Number));
        assert!(guess.can_guess(&Type::String));
        assert!(guess.can_guess(&Type::Boolean));
        assert!(guess.can_guess(&Type::Object(BTreeMap::new())));
        assert!(guess.can_guess(&Type::Class("Foo".to_string())));
        assert!(guess.can_guess(&Type::Array(Box::new(Type::Number))));
        assert!(guess.can_guess(&Type::Undefined));
        assert!(guess.can_guess(&Type::Null));
        assert!(guess.can_guess(&Type::Function));
    }

    #[test]
    fn test_can_guess_class() {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Class, 1.0);
        let mut class_dist = BTreeMap::new();
        class_dist.insert("MyClass".to_string(), 1.0);
        let guess = TypeGuess {
            is_any: false,
            kind,
            class_type: Some(class_dist),
            ..Default::default()
        };

        assert!(guess.can_guess(&Type::Class("MyClass".to_string())));
        assert!(!guess.can_guess(&Type::Class("OtherClass".to_string())));
    }

    #[test]
    fn test_can_guess_object() {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Object, 1.0);
        let mut shape = BTreeMap::new();
        shape.insert("x".to_string(), number_guess());
        shape.insert("y".to_string(), string_guess());
        let guess = TypeGuess {
            is_any: false,
            kind,
            object_shape: Some(shape),
            ..Default::default()
        };

        let mut matching_obj = BTreeMap::new();
        matching_obj.insert("x".to_string(), Type::Number);
        matching_obj.insert("y".to_string(), Type::String);
        assert!(guess.can_guess(&Type::Object(matching_obj)));

        let mut wrong_field = BTreeMap::new();
        wrong_field.insert("x".to_string(), Type::String);
        assert!(!guess.can_guess(&Type::Object(wrong_field)));

        let mut missing_field = BTreeMap::new();
        missing_field.insert("z".to_string(), Type::Number);
        assert!(!guess.can_guess(&Type::Object(missing_field)));
    }

    #[test]
    fn test_can_guess_array() {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Array, 1.0);
        let guess = TypeGuess {
            is_any: false,
            kind,
            array_value_type: Some(Box::new(number_guess())),
            ..Default::default()
        };

        assert!(guess.can_guess(&Type::Array(Box::new(Type::Number))));
        assert!(!guess.can_guess(&Type::Array(Box::new(Type::String))));
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

    #[test]
    fn test_probability_of_matching() {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Number, 0.7);
        kind.insert(TypeKind::String, 0.3);
        let guess = TypeGuess {
            is_any: false,
            kind,
            ..Default::default()
        };
        let prob = guess.probability_of(&Type::Number);
        assert!((prob - 0.7).abs() < f64::EPSILON);
    }

    #[test]
    fn test_probability_of_non_matching() {
        let guess = number_guess();
        let prob = guess.probability_of(&Type::String);
        assert!((prob - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_probability_of_any() {
        let guess = TypeGuess::any();
        let prob = guess.probability_of(&Type::Boolean);
        assert!((prob - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_sample_type_guess_number() {
        let guess = number_guess();
        let mut rand = StdRand::with_seed(42);
        let result = guess.sample(&mut rand).unwrap();
        assert!(matches!(result, Type::Number));
    }

    #[test]
    fn test_sample_type_guess_any() {
        let guess = TypeGuess::any();
        let mut rand = StdRand::with_seed(42);
        let result = guess.sample(&mut rand);
        assert!(result.is_ok());
    }

    #[test]
    fn test_can_receive_matching() {
        let sig = SignatureGuess {
            args: vec![number_guess(), string_guess()],
            ret: number_guess(),
            callconv: CallConvention::Free,
            builtin: None,
        };
        let ports = sig.can_receive(&[Type::Number]);
        assert_eq!(ports, Some(vec![0]));
    }

    #[test]
    fn test_can_receive_no_match() {
        let sig = SignatureGuess {
            args: vec![number_guess()],
            ret: number_guess(),
            callconv: CallConvention::Free,
            builtin: None,
        };
        let ports = sig.can_receive(&[Type::String]);
        assert_eq!(ports, None);
    }

    #[test]
    fn test_can_receive_multiple_args() {
        let sig = SignatureGuess {
            args: vec![number_guess(), string_guess(), boolean_guess()],
            ret: number_guess(),
            callconv: CallConvention::Free,
            builtin: None,
        };
        let ports = sig.can_receive(&[Type::String, Type::Boolean]);
        assert_eq!(ports, Some(vec![1, 2]));
    }

    #[test]
    fn test_concretize_by_return_type() {
        let schema = make_schema(vec![
            (
                "foo",
                SignatureGuess {
                    args: vec![],
                    ret: number_guess(),
                    callconv: CallConvention::Free,
                    builtin: None,
                },
            ),
            (
                "bar",
                SignatureGuess {
                    args: vec![],
                    ret: string_guess(),
                    callconv: CallConvention::Free,
                    builtin: None,
                },
            ),
        ]);
        let mut rand = StdRand::with_seed(42);
        let query = SignatureQuery {
            args: None,
            ret: Some(Type::String),
            callconv: None,
        };
        let result = schema.concretize(&mut rand, query);
        assert!(result.is_some());
        let (name, sig, _) = result.unwrap();
        assert_eq!(name, "bar");
        assert!(matches!(sig.ret, Type::String));
    }

    #[test]
    fn test_concretize_by_callconv() {
        let schema = make_schema(vec![
            (
                "free_fn",
                SignatureGuess {
                    args: vec![],
                    ret: number_guess(),
                    callconv: CallConvention::Free,
                    builtin: None,
                },
            ),
            (
                "ctor",
                SignatureGuess {
                    args: vec![],
                    ret: number_guess(),
                    callconv: CallConvention::Constructor,
                    builtin: None,
                },
            ),
        ]);
        let mut rand = StdRand::with_seed(42);
        let query = SignatureQuery {
            args: None,
            ret: None,
            callconv: Some(CallConvention::Constructor),
        };
        let result = schema.concretize(&mut rand, query);
        assert!(result.is_some());
        let (name, sig, _) = result.unwrap();
        assert_eq!(name, "ctor");
        assert_eq!(sig.callconv, CallConvention::Constructor);
    }

    #[test]
    fn test_concretize_no_match() {
        let schema = make_schema(vec![(
            "foo",
            SignatureGuess {
                args: vec![],
                ret: number_guess(),
                callconv: CallConvention::Free,
                builtin: None,
            },
        )]);
        let mut rand = StdRand::with_seed(42);
        let query = SignatureQuery {
            args: None,
            ret: Some(Type::Boolean),
            callconv: None,
        };
        let result = schema.concretize(&mut rand, query);
        assert!(result.is_none());
    }

    #[test]
    fn test_normalize() {
        let mut dist: BTreeMap<&str, f64> = BTreeMap::new();
        dist.insert("a", 2.0);
        dist.insert("b", 3.0);
        dist.insert("c", 5.0);
        Schema::normalize(&mut dist);
        let total: f64 = dist.values().sum();
        assert!((total - 1.0).abs() < f64::EPSILON);
        assert!((dist["a"] - 0.2).abs() < f64::EPSILON);
        assert!((dist["b"] - 0.3).abs() < f64::EPSILON);
        assert!((dist["c"] - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn test_type_sample_number() {
        let mut rand = StdRand::with_seed(42);
        let result = Type::Number.sample(&mut rand).unwrap();
        assert!(matches!(result, ConstantValue::Number(_)));
    }

    #[test]
    fn test_type_sample_string() {
        let mut rand = StdRand::with_seed(42);
        let result = Type::String.sample(&mut rand).unwrap();
        assert!(matches!(result, ConstantValue::String(_)));
    }

    #[test]
    fn test_type_sample_boolean() {
        let mut rand = StdRand::with_seed(42);
        let result = Type::Boolean.sample(&mut rand).unwrap();
        assert!(matches!(result, ConstantValue::Boolean(_)));
    }

    #[test]
    fn test_type_sample_object() {
        let mut rand = StdRand::with_seed(42);
        let mut shape = BTreeMap::new();
        shape.insert("a".to_string(), Type::Number);
        shape.insert("b".to_string(), Type::String);
        let result = Type::Object(shape).sample(&mut rand).unwrap();
        match result {
            ConstantValue::Object(props) => {
                assert!(props.contains_key("a"));
                assert!(props.contains_key("b"));
                assert!(matches!(props["a"], ConstantValue::Number(_)));
                assert!(matches!(props["b"], ConstantValue::String(_)));
            }
            _ => panic!("expected ConstantValue::Object"),
        }
    }

    #[test]
    fn test_type_sample_class_fails() {
        let mut rand = StdRand::with_seed(42);
        let result = Type::Class("Foo".to_string()).sample(&mut rand);
        assert!(result.is_err());
    }

    #[test]
    fn test_type_sample_array() {
        let mut rand = StdRand::with_seed(42);
        let result = Type::Array(Box::new(Type::Number))
            .sample(&mut rand)
            .unwrap();
        assert!(matches!(result, ConstantValue::Array(_)));
    }

    #[test]
    fn test_find_port() {
        let sig = Signature {
            args: vec![Type::Number, Type::String, Type::Boolean],
            ret: Type::Undefined,
            callconv: CallConvention::Free,
        };
        assert_eq!(sig.find_port(&Type::String), Some(1));
        assert_eq!(sig.find_port(&Type::Boolean), Some(2));
        assert_eq!(sig.find_port(&Type::Null), None);
    }
}
