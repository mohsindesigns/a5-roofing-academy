import {
  Body,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Param,
  PipeTransform,
  Query,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiBody, ApiOkResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';
import { map, type Observable } from 'rxjs';
import { ValidationError } from './errors.js';
import type { FieldError } from './types.js';

export function zodIssuesToFields(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}

export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) throw new ValidationError(zodIssuesToFields(result.error));
    return result.data;
  }
}

/** JSON Schema for OpenAPI docs, derived from the same Zod contract used at runtime. */
export function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io, unrepresentable: 'any' }) as Record<string, unknown>;
}

function applyMethodDecorator(target: object, key: string | symbol | undefined, decorator: MethodDecorator): void {
  if (key === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor) decorator(target, key, descriptor);
}

/** Validated request body. */
export function ZBody(schema: z.ZodType): ParameterDecorator {
  return (target, key, index) => {
    Body(new ZodValidationPipe(schema))(target, key, index);
    applyMethodDecorator(target, key, ApiBody({ schema: jsonSchema(schema) }));
  };
}

/** Validated query string (coerced through the schema). */
export function ZQuery(schema: z.ZodObject): ParameterDecorator {
  return (target, key, index) => {
    Query(new ZodValidationPipe(schema))(target, key, index);
    const shape = (jsonSchema(schema).properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((jsonSchema(schema).required as string[] | undefined) ?? []);
    for (const [name, prop] of Object.entries(shape)) {
      applyMethodDecorator(target, key, ApiQuery({ name, required: required.has(name), schema: prop }));
    }
  };
}

/** Validated route parameter. Defaults to UUID validation. */
export function ZParam(name: string, schema: z.ZodType = z.uuid()): ParameterDecorator {
  const wrapped = z.object({ [name]: schema });
  return (target, key, index) => {
    Param(name, {
      transform: (value: unknown) => new ZodValidationPipe(wrapped).transform({ [name]: value })[name],
    })(target, key, index);
    applyMethodDecorator(target, key, ApiParam({ name, schema: jsonSchema(schema) }));
  };
}

export const RESPONSE_SCHEMA = 'a5:response-schema';

/**
 * Declares the response contract. The interceptor parses every response through it, which strips
 * properties that are not part of the contract, so internal columns cannot leak by accident.
 */
export function ZResponse(schema: z.ZodType, description = 'OK'): MethodDecorator {
  return applyDecorators(
    SetMetadata(RESPONSE_SCHEMA, schema),
    ApiOkResponse({ description, schema: jsonSchema(schema, 'output') }),
  );
}

export class ResponseContractError extends Error {
  constructor(readonly issues: FieldError[]) {
    super('Response does not match its contract');
    this.name = 'ResponseContractError';
  }
}

@Injectable()
export class ResponseSchemaInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.get<z.ZodType | undefined>(RESPONSE_SCHEMA, context.getHandler());
    if (!schema) return next.handle();
    return next.handle().pipe(
      map((value: unknown) => {
        const result = schema.safeParse(value);
        if (!result.success) throw new ResponseContractError(zodIssuesToFields(result.error));
        return result.data;
      }),
    );
  }
}
