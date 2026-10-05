import { z } from 'zod';

/** Keywords that strict structured-output modes reject; bounds are enforced by Zod after parsing. */
const UNSUPPORTED = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED.has(key)) continue;
    out[key] = key === 'properties' ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, sanitize(v)])) : sanitize(value);
  }
  if (out.type === 'object' || out.properties) {
    out.additionalProperties = false;
    if (out.properties && !out.required) out.required = Object.keys(out.properties as object);
  }
  // `type: ["string", "null"]` → `anyOf`, the nullable form every structured-output mode accepts.
  if (Array.isArray(out.type)) {
    const { type, enum: values, description, ...rest } = out as { type: string[]; enum?: unknown[]; description?: string };
    const anyOf = type.map((t) => {
      if (t === 'null') return { type: 'null' };
      const branch: Record<string, unknown> = { ...rest, type: t };
      if (values) branch.enum = values.filter((v) => v !== null);
      return branch;
    });
    return description ? { description, anyOf } : { anyOf };
  }
  return out;
}

/**
 * JSON Schema for provider structured output, generated from the Zod schema (single source of
 * truth). Every object is closed (`additionalProperties: false`) with all properties required, as
 * strict tool use / structured outputs require; numeric and length bounds are re-checked by Zod.
 */
export function providerJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'any' });
  return sanitize(generated) as Record<string, unknown>;
}

/** Parse model output text that should contain one JSON object (tolerates code fences). */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error('Output is not JSON');
  }
}
