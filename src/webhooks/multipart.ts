import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';

/**
 * Mailgun posts EVERY MIME part as a file (inline signature logos included) and caps a message at
 * 25 MB, so a per-file cap above that never fires before Mailgun's own does. busboy's default
 * fieldSize is 1 MB — a long HTML thread exceeded it and aborted the whole request.
 */
export const MULTIPART_LIMITS = {
  fileSize: 25 * 1024 * 1024,
  files: 30,
  fieldSize: 5 * 1024 * 1024,
  fields: 200,
} as const;

export interface MailgunRequest extends Request {
  /** Set by mailgunMultipart() instead of failing the request. */
  multerError?: Error & { code?: string };
}

/**
 * Multer with limit errors CAPTURED onto the request instead of thrown. A thrown MulterError
 * became a 500 before the controller ran; Mailgun retried the identical payload for ~8 h and then
 * dropped the email with no row anywhere. Capturing lets the controller write a `failed` intake
 * row and answer 200, so the loss is visible in email_intake_log and the retries stop.
 */
export function mailgunMultipart(
  upload: RequestHandler = multer({ storage: multer.memoryStorage(), limits: MULTIPART_LIMITS }).any(),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err?: unknown) => {
      if (err) (req as MailgunRequest).multerError = err as MailgunRequest['multerError'];
      next();
    });
  };
}
