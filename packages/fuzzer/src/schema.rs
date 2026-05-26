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

    /// Whether a value described by `self` is safe to use wherever a value
    /// described by `other` is expected. This is an asymmetric "subtype-or-
    /// equal" check: a producer's return guess (`self`) is `assignable_to`
    /// a consumer's argument guess (`other`) iff every value the producer
    /// could plausibly return is accepted by the consumer's slot.
    ///
    /// Concretely:
    ///   * every kind `self` can yield must also be acceptable to `other`
    ///     (otherwise `self` could return a value of a kind the consumer
    ///     does not accept);
    ///   * for `Object`, every key required by `other`'s shape must be
    ///     present in `self`'s shape with an assignable value type
    ///     (otherwise the consumer would dereference a missing property);
    ///   * for `Class`, every class `self` could return must be in the set
    ///     of classes `other` accepts (otherwise the consumer could be
    ///     handed a wrong class instance);
    ///   * for `Array`, `self`'s element type must be assignable to
    ///     `other`'s element type;
    ///   * `None` shape / class / element on `self` means we don't have a
    ///     more precise constraint; we let it through and let the consumer's
    ///     slot drive the soundness check. `None` on `other` means the
    ///     consumer accepts any value of that kind.
    pub fn assignable_to(&self, other: &TypeGuess) -> bool {
        if self.is_any || other.is_any {
            return true;
        }

        let mine: HashSet<&TypeKind> = self.kind.keys().collect();
        let theirs: HashSet<&TypeKind> = other.kind.keys().collect();

        // Every kind `self` could produce must be acceptable to `other`.
        // (Equivalently: `self.kind`'s key set is a subset of `other.kind`'s
        // key set.)
        if !mine.is_subset(&theirs) {
            return false;
        }

        // For each shared kind, the structural constraints must also be
        // compatible in the asymmetric `self <: other` sense.
        mine.iter().all(|kind| match kind {
            TypeKind::Object => match (&self.object_shape, &other.object_shape) {
                // Unconstrained slot accepts anything; unconstrained value
                // is treated as "we don't know more" and let through.
                (_, None) | (None, _) => true,
                (Some(s), Some(o)) => o
                    .iter()
                    .all(|(k, vo)| s.get(k).is_some_and(|vs| vs.assignable_to(vo))),
            },
            TypeKind::Class => match (&self.class_type, &other.class_type) {
                (_, None) | (None, _) => true,
                (Some(s), Some(o)) => s.keys().all(|k| o.contains_key(k)),
            },
            TypeKind::Array => match (&self.array_value_type, &other.array_value_type) {
                (_, None) | (None, _) => true,
                (Some(s), Some(o)) => s.assignable_to(o),
            },
            _ => true,
        })
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

        if !self.is_const_able() {
            bail!("cannot sample guess as const type")
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

    /// This is a pure JSON object that we can create in-place.
    /// This means neither this nor its nested guesses are class-only. The generator
    /// should use class constructors instead.
    pub fn is_const_able(&self) -> bool {
        if self.is_any {
            return true;
        }

        if self.is_only_class() {
            return false;
        }

        if self.kind.contains_key(&TypeKind::Object) {
            // Without a known shape we cannot synthesize an object literal
            // (see `sample_const_type`), so this kind is not const-able.
            let Some(shape) = &self.object_shape else {
                return false;
            };
            if shape.values().any(|g| !g.is_const_able()) {
                return false;
            }
        }

        if self.kind.contains_key(&TypeKind::Array) {
            // Without a known element type we cannot synthesize array
            // elements (see `sample_const_type`), so this kind is not
            // const-able.
            let Some(elem) = &self.array_value_type else {
                return false;
            };
            if !elem.is_const_able() {
                return false;
            }
        }

        true
    }

    fn is_only_class(&self) -> bool {
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
    fn test_assignable_to_same_kind() {
        // a producer that only returns Number is assignable to a consumer
        // that accepts Number | String.
        let a = number_guess();
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Number, 0.5);
        kind.insert(TypeKind::String, 0.5);
        let b = TypeGuess {
            is_any: false,
            kind,
            ..Default::default()
        };
        assert!(a.assignable_to(&b));
        // ...but a Number | String producer is NOT assignable to a Number
        // consumer because it could return a String at runtime.
        assert!(!b.assignable_to(&a));
    }

    #[test]
    fn test_assignable_to_disjoint() {
        let a = number_guess();
        let b = string_guess();
        assert!(!a.assignable_to(&b));
    }

    #[test]
    fn test_assignable_to_any() {
        let a = TypeGuess::any();
        let b = number_guess();
        assert!(a.assignable_to(&b));
        assert!(b.assignable_to(&a));
    }

    fn object_guess(shape: Option<BTreeMap<String, TypeGuess>>) -> TypeGuess {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Object, 1.0);
        TypeGuess {
            is_any: false,
            kind,
            object_shape: shape,
            ..Default::default()
        }
    }

    fn class_guess(names: &[&str]) -> TypeGuess {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Class, 1.0);
        let class_type = if names.is_empty() {
            None
        } else {
            let mut m = BTreeMap::new();
            for n in names {
                m.insert((*n).to_string(), 1.0);
            }
            Some(m)
        };
        TypeGuess {
            is_any: false,
            kind,
            class_type,
            ..Default::default()
        }
    }

    fn array_guess(elem: Option<TypeGuess>) -> TypeGuess {
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Array, 1.0);
        TypeGuess {
            is_any: false,
            kind,
            array_value_type: elem.map(Box::new),
            ..Default::default()
        }
    }

    #[test]
    fn test_assignable_to_object_superset_producer() {
        // A producer whose shape is a superset of the consumer's expected
        // shape (with compatible value types) is assignable. The producer
        // has every key the consumer requires, with an extra field that is
        // simply ignored.
        let mut producer_shape = BTreeMap::new();
        producer_shape.insert("name".to_string(), string_guess());
        producer_shape.insert("count".to_string(), number_guess());

        let mut consumer_shape = BTreeMap::new();
        consumer_shape.insert("name".to_string(), string_guess());

        let producer = object_guess(Some(producer_shape));
        let consumer = object_guess(Some(consumer_shape));

        assert!(producer.assignable_to(&consumer));
        // The reverse is NOT sound: the producer here is missing `count`,
        // so it cannot fill a slot that requires `count`.
        assert!(!consumer.assignable_to(&producer));
    }

    #[test]
    fn test_assignable_to_object_missing_required_key() {
        // Regression for a soundness bug: even when two object shapes
        // share at least one key, the producer is NOT assignable to the
        // consumer if the consumer requires additional keys the producer
        // doesn't have.
        let mut producer_shape = BTreeMap::new();
        producer_shape.insert("name".to_string(), string_guess());

        let mut consumer_shape = BTreeMap::new();
        consumer_shape.insert("name".to_string(), string_guess());
        consumer_shape.insert("age".to_string(), number_guess());

        let producer = object_guess(Some(producer_shape));
        let consumer = object_guess(Some(consumer_shape));

        // Producer is missing `age` and would crash any consumer that
        // dereferences `.age`.
        assert!(!producer.assignable_to(&consumer));
    }

    #[test]
    fn test_assignable_to_object_disjoint_shapes() {
        // Regression: parseTemplate's return shape vs.
        // compileDirectiveFromMetadata's first arg shape — both "Object" at
        // the top level, but they share no keys, so should NOT be assignable.
        let mut a_shape = BTreeMap::new();
        a_shape.insert("preserveWhitespaces".to_string(), string_guess());
        a_shape.insert("errors".to_string(), string_guess());

        let mut b_shape = BTreeMap::new();
        b_shape.insert("name".to_string(), string_guess());
        b_shape.insert("typeArgumentCount".to_string(), number_guess());

        let a = object_guess(Some(a_shape));
        let b = object_guess(Some(b_shape));

        assert!(!a.assignable_to(&b));
        assert!(!b.assignable_to(&a));
    }

    #[test]
    fn test_assignable_to_object_shared_key_incompatible_value() {
        let mut a_shape = BTreeMap::new();
        a_shape.insert("name".to_string(), string_guess());

        let mut b_shape = BTreeMap::new();
        b_shape.insert("name".to_string(), number_guess());

        let a = object_guess(Some(a_shape));
        let b = object_guess(Some(b_shape));

        assert!(!a.assignable_to(&b));
    }

    #[test]
    fn test_assignable_to_object_unconstrained_shape() {
        let mut shape = BTreeMap::new();
        shape.insert("name".to_string(), string_guess());

        let constrained = object_guess(Some(shape));
        let unconstrained = object_guess(None);

        assert!(constrained.assignable_to(&unconstrained));
        assert!(unconstrained.assignable_to(&constrained));
    }

    #[test]
    fn test_assignable_to_object_empty_shapes() {
        // Regression: two empty object shapes (e.g. inferred from the
        // TypeScript `object` keyword) must still be considered assignable.
        // The old "any shared key" check returned `false` here because there
        // were no keys to iterate.
        let a = object_guess(Some(BTreeMap::new()));
        let b = object_guess(Some(BTreeMap::new()));
        assert!(a.assignable_to(&b));
        assert!(b.assignable_to(&a));
    }

    #[test]
    fn test_assignable_to_object_empty_producer_into_constrained_slot() {
        // An empty inferred shape cannot satisfy a consumer that demands a
        // specific key. (The producer doesn't have the key.)
        let producer = object_guess(Some(BTreeMap::new()));
        let mut consumer_shape = BTreeMap::new();
        consumer_shape.insert("name".to_string(), string_guess());
        let consumer = object_guess(Some(consumer_shape));
        assert!(!producer.assignable_to(&consumer));
    }

    #[test]
    fn test_assignable_to_class_same_name() {
        let a = class_guess(&["ConstantPool"]);
        let b = class_guess(&["ConstantPool"]);
        assert!(a.assignable_to(&b));
    }

    #[test]
    fn test_assignable_to_class_different_names() {
        // Regression: a Buffer should not be considered compatible with a
        // ConstantPool slot just because both kinds are "Class".
        let a = class_guess(&["Buffer"]);
        let b = class_guess(&["ConstantPool"]);
        assert!(!a.assignable_to(&b));
        assert!(!b.assignable_to(&a));
    }

    #[test]
    fn test_assignable_to_class_producer_union_is_unsound() {
        // Regression for a soundness bug: a producer that might return
        // either Buffer or ConstantPool is NOT assignable to a slot that
        // only accepts ConstantPool, because at runtime the producer could
        // return a Buffer.
        let producer = class_guess(&["Buffer", "ConstantPool"]);
        let consumer = class_guess(&["ConstantPool"]);
        assert!(!producer.assignable_to(&consumer));
        // The reverse direction is sound: a producer that always returns
        // ConstantPool fits into a slot that accepts Buffer | ConstantPool.
        assert!(consumer.assignable_to(&producer));
    }

    #[test]
    fn test_assignable_to_class_unconstrained() {
        let constrained = class_guess(&["ConstantPool"]);
        let unconstrained = class_guess(&[]);
        assert!(constrained.assignable_to(&unconstrained));
        assert!(unconstrained.assignable_to(&constrained));
    }

    #[test]
    fn test_assignable_to_array_compatible_elements() {
        let a = array_guess(Some(number_guess()));
        let b = array_guess(Some(number_guess()));
        assert!(a.assignable_to(&b));
    }

    #[test]
    fn test_assignable_to_array_disjoint_elements() {
        let a = array_guess(Some(number_guess()));
        let b = array_guess(Some(string_guess()));
        assert!(!a.assignable_to(&b));
    }

    #[test]
    fn test_assignable_to_array_unconstrained_element() {
        let constrained = array_guess(Some(number_guess()));
        let unconstrained = array_guess(None);
        assert!(constrained.assignable_to(&unconstrained));
        assert!(unconstrained.assignable_to(&constrained));
    }

    #[test]
    fn test_assignable_to_multi_kind_union_is_unsound() {
        // Regression for a soundness bug: the previous "shared kind +
        // structural compatibility" overlap check let a `Buffer | Number`
        // producer flow into a `ConstantPool | Number` slot via the
        // Number arm, even though the producer can still return a Buffer
        // at runtime. With proper subtyping semantics, this is rejected
        // because the producer's Class arm isn't compatible.
        let mut a_kind = BTreeMap::new();
        a_kind.insert(TypeKind::Number, 0.5);
        a_kind.insert(TypeKind::Class, 0.5);
        let mut a_class = BTreeMap::new();
        a_class.insert("Buffer".to_string(), 1.0);
        let a = TypeGuess {
            is_any: false,
            kind: a_kind,
            class_type: Some(a_class),
            ..Default::default()
        };

        let mut b_kind = BTreeMap::new();
        b_kind.insert(TypeKind::Number, 0.5);
        b_kind.insert(TypeKind::Class, 0.5);
        let mut b_class = BTreeMap::new();
        b_class.insert("ConstantPool".to_string(), 1.0);
        let b = TypeGuess {
            is_any: false,
            kind: b_kind,
            class_type: Some(b_class),
            ..Default::default()
        };

        assert!(!a.assignable_to(&b));
    }

    #[test]
    fn test_assignable_to_kind_union_producer_into_narrow_slot() {
        // A producer returning Number | String is not assignable to a
        // Number-only slot.
        let mut a_kind = BTreeMap::new();
        a_kind.insert(TypeKind::Number, 0.5);
        a_kind.insert(TypeKind::String, 0.5);
        let producer = TypeGuess {
            is_any: false,
            kind: a_kind,
            ..Default::default()
        };
        let consumer = number_guess();
        assert!(!producer.assignable_to(&consumer));
    }

    #[test]
    fn test_is_const_able_object_without_shape() {
        // Regression: a TypeGuess that says "Object" without a known shape
        // cannot be turned into a constant literal because
        // `sample_const_type` would `bail!`. `is_const_able` must therefore
        // return false to keep the two in sync.
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Object, 1.0);
        let guess = TypeGuess {
            is_any: false,
            kind,
            object_shape: None,
            ..Default::default()
        };
        assert!(!guess.is_const_able());
    }

    #[test]
    fn test_is_const_able_array_without_element_type() {
        // Regression: same as above for unconstrained arrays.
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Array, 1.0);
        let guess = TypeGuess {
            is_any: false,
            kind,
            array_value_type: None,
            ..Default::default()
        };
        assert!(!guess.is_const_able());
    }

    #[test]
    fn test_is_const_able_mixed_object_without_shape_is_unsafe() {
        // Even when other kinds are present, if `Object` is in the union we
        // can't safely call `sample_const_type` because `kind.sample` might
        // pick `Object` and bail.
        let mut kind = BTreeMap::new();
        kind.insert(TypeKind::Number, 0.5);
        kind.insert(TypeKind::Object, 0.5);
        let guess = TypeGuess {
            is_any: false,
            kind,
            object_shape: None,
            ..Default::default()
        };
        assert!(!guess.is_const_able());
    }
}
