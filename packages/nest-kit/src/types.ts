import type { Principal } from '@a5/auth';
import type { Request } from 'express';

export interface FieldError {
  path: string;
  message: string;
}

export interface A5Request extends Request {
  principal?: Principal;
  serviceCaller?: string;
  requestId?: string;
}
