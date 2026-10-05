import { z } from 'zod';

/**
 * Numeric limits and defaults for form fields, read from the Zod schemas that the API validates
 * with (`@a5/rules`, `@a5/contracts`). The editors never repeat a limit such as "0 to 100": they
 * ask the schema, so a change to the schema changes the form.
 */
export interface FieldBounds {
  min?: number;
  max?: number;
  /** Schema default, when the schema declares one. */
  default?: unknown;
  integer: boolean;
  enum?: string[];
}

interface JsonSchemaNode {
  type?: string | string[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  items?: JsonSchemaNode;
}

// The largest integers a schema reports when no explicit bound was given are not useful limits.
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/** `nullable()` fields become `anyOf: [T, null]`; the limits belong to the non-null member. */
function unwrap(node: JsonSchemaNode | undefined): JsonSchemaNode | undefined {
  const members = node?.anyOf ?? node?.oneOf;
  if (!node || !members) return node;
  const inner = members.find((m) => m.type !== 'null');
  return inner ? { ...inner, default: node.default ?? inner.default } : node;
}

function toBounds(raw: JsonSchemaNode | undefined): FieldBounds {
  const node = unwrap(raw);
  const types = Array.isArray(node?.type) ? node.type : [node?.type];
  const bounds: FieldBounds = { integer: types.includes('integer') };
  if (node?.minimum !== undefined && Math.abs(node.minimum) < UNBOUNDED) bounds.min = node.minimum;
  if (node?.maximum !== undefined && node.maximum < UNBOUNDED) bounds.max = node.maximum;
  if (node?.default !== undefined) bounds.default = node.default;
  if (node?.enum) bounds.enum = node.enum.map(String);
  return bounds;
}

/** Bounds for every property of an object schema. */
export function objectBounds(schema: z.ZodType): Record<string, FieldBounds> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaNode;
  const out: Record<string, FieldBounds> = {};
  for (const [name, node] of Object.entries(json.properties ?? {})) out[name] = toBounds(node);
  return out;
}

const cache = new WeakMap<z.ZodType, Record<string, FieldBounds>>();

export function boundsOf(schema: z.ZodType): Record<string, FieldBounds> {
  let hit = cache.get(schema);
  if (!hit) {
    hit = objectBounds(schema);
    cache.set(schema, hit);
  }
  return hit;
}

/** Bounds per property for each member of a discriminated union, keyed by the discriminator value. */
export function unionBounds(
  schema: z.ZodType,
  discriminator: string,
): Record<string, Record<string, FieldBounds>> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaNode;
  const members = json.oneOf ?? json.anyOf ?? [];
  const out: Record<string, Record<string, FieldBounds>> = {};
  for (const member of members) {
    const tag = member.properties?.[discriminator];
    const key = tag?.const ?? tag?.enum?.[0];
    if (typeof key !== 'string') continue;
    const fields: Record<string, FieldBounds> = {};
    for (const [name, node] of Object.entries(member.properties ?? {})) {
      if (name !== discriminator) fields[name] = toBounds(node);
    }
    out[key] = fields;
  }
  return out;
}

/** Help text such as "0 to 100" for a bounded field, or undefined when unbounded. */
export function rangeHint(b: FieldBounds | undefined, unit = ''): string | undefined {
  if (!b) return undefined;
  if (b.min !== undefined && b.max !== undefined) return `${b.min}${unit} to ${b.max}${unit}`;
  if (b.min !== undefined) return `${b.min}${unit} or more`;
  if (b.max !== undefined) return `${b.max}${unit} or less`;
  return undefined;
}
