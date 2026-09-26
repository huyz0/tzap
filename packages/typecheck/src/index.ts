export { createTypeChecker, newDiagnostics, type TypeChecker, type TypeCheckerOptions, type TypeCheckStats } from './checker.js';
export { type Backend, type Diag, type TypeScriptChoice } from './backend.js';
export {
  typeFilters,
  TYPE_RULES,
  type TypeRule,
  returningBodyRule,
  requiredPropertiesRule,
  usedKeysRule,
  calledArrowRule,
  declaredReturnArrowRule,
  nullableReceiverRule,
  nullishToAndRule,
  nullishToAndLooseRule,
  booleanInValuePositionRule,
  untypedArrayRule,
} from './rules.js';
