import type { notification } from '@a5/contracts';

type Conditions = notification.RuleConditions;
type Literal = string | number | boolean | null;

/** Read a dotted path (`context.programId`) from an event payload. */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function equals(actual: unknown, expected: Literal): boolean {
  if (expected === null) return actual === null || actual === undefined;
  return actual === expected;
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesOne(actual: unknown, condition: Conditions[string]): boolean {
  if (Array.isArray(condition)) return condition.some((c) => equals(actual, c));
  if (!isOperatorObject(condition)) return equals(actual, condition as Literal);
  const ops = condition as {
    eq?: Literal;
    ne?: Literal;
    in?: Literal[];
    notIn?: Literal[];
    gt?: number;
    gte?: number;
    lt?: number;
    lte?: number;
  };
  if ('eq' in ops && !equals(actual, ops.eq as Literal)) return false;
  if ('ne' in ops && equals(actual, ops.ne as Literal)) return false;
  if (ops.in && !ops.in.some((c) => equals(actual, c))) return false;
  if (ops.notIn && ops.notIn.some((c) => equals(actual, c))) return false;
  const numeric = typeof actual === 'number' ? actual : null;
  if (ops.gt !== undefined && (numeric === null || !(numeric > ops.gt))) return false;
  if (ops.gte !== undefined && (numeric === null || !(numeric >= ops.gte))) return false;
  if (ops.lt !== undefined && (numeric === null || !(numeric < ops.lt))) return false;
  if (ops.lte !== undefined && (numeric === null || !(numeric <= ops.lte))) return false;
  return true;
}

/** True when every condition holds for the payload. An empty object always matches. */
export function matchesConditions(
  payload: unknown,
  conditions: Conditions | null | undefined,
): boolean {
  if (!conditions) return true;
  return Object.entries(conditions).every(([path, condition]) =>
    matchesOne(readPath(payload, path), condition),
  );
}
