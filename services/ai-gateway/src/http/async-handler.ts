import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function jsonErrorHandler(errorCode: string, status = 502): ErrorRequestHandler {
  return (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    console.error(errorCode, error);
    res.status(status).json({ error: errorCode });
  };
}
