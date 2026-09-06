import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { MULTIPART_LIMITS, MailgunRequest, mailgunMultipart } from './multipart';

describe('mailgunMultipart', () => {
  const run = (upload: RequestHandler) => {
    const req = {} as MailgunRequest;
    const next = jest.fn();
    mailgunMultipart(upload)(req as Request, {} as Response, next as NextFunction);
    return { req, next };
  };

  it('captures a multer error on the request and still calls next()', () => {
    const err = Object.assign(new Error('Too many files'), { code: 'LIMIT_FILE_COUNT' });
    const { req, next } = run(((_req, _res, cb) => cb(err)) as RequestHandler);
    expect(req.multerError?.code).toBe('LIMIT_FILE_COUNT');
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('leaves the request untouched on success', () => {
    const { req, next } = run(((_req, _res, cb) => cb()) as RequestHandler);
    expect(req.multerError).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  it('limits are wide enough for Mailgun (25 MB parts, 30 parts, 5 MB fields)', () => {
    expect(MULTIPART_LIMITS.fileSize).toBe(25 * 1024 * 1024);
    expect(MULTIPART_LIMITS.files).toBe(30);
    expect(MULTIPART_LIMITS.fieldSize).toBe(5 * 1024 * 1024);
  });
});
