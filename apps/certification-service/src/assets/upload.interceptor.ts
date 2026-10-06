import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Type,
  mixin,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { Observable } from 'rxjs';
import { AppError } from '@a5/nest-kit';

export interface UploadedImage {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function toAppError(err: unknown, maxBytes: number): AppError {
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return new AppError(
          413,
          'FILE_TOO_LARGE',
          `Images must be ${Math.round((maxBytes / 1024 / 1024) * 10) / 10} MB or smaller.`,
        );
      case 'LIMIT_UNEXPECTED_FILE':
      case 'LIMIT_FILE_COUNT':
        return new AppError(
          400,
          'UNEXPECTED_FILE',
          'Send exactly one image in a form field named "file".',
        );
      default:
        return new AppError(
          400,
          'INVALID_UPLOAD',
          'The upload could not be read. Send the image as multipart/form-data.',
        );
    }
  }
  return new AppError(
    400,
    'INVALID_UPLOAD',
    'The upload could not be read. Send the image as multipart/form-data.',
  );
}

/**
 * Strict multipart parsing into memory: one file field named "file", a hard byte limit (multer
 * aborts the stream as soon as it is exceeded) and a handful of small text fields.
 */
export function ImageUpload(maxBytes: number): Type<NestInterceptor> {
  @Injectable()
  class ImageUploadInterceptor implements NestInterceptor {
    private readonly parse = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: maxBytes,
        files: 1,
        fields: 4,
        parts: 5,
        fieldSize: 2048,
        headerPairs: 50,
      },
    }).single('file');

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
      const http = context.switchToHttp();
      const req = http.getRequest<Request>();
      const res = http.getResponse<Response>();
      if (!req.is('multipart/form-data')) {
        throw new AppError(
          415,
          'MULTIPART_REQUIRED',
          'Upload the image as multipart/form-data with a "file" field.',
        );
      }
      await new Promise<void>((resolve, reject) => {
        this.parse(req, res, (err: unknown) =>
          err ? reject(toAppError(err, maxBytes)) : resolve(),
        );
      });
      if (!(req as Request & { file?: UploadedImage }).file) {
        throw new AppError(400, 'FILE_REQUIRED', 'Choose an image to upload (form field "file").');
      }
      return next.handle();
    }
  }
  return mixin(ImageUploadInterceptor);
}
