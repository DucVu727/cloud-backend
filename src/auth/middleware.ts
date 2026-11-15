import type { RequestHandler } from 'express';
import { Errors } from '../errors';
import type { AuthProvider, AuthUser } from './types';

/** Đọc Bearer token (nếu có) và gắn req.user. Không chặn request. */
export function authenticate(provider: AuthProvider): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header) return next();
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return next(Errors.unauthorized('Header Authorization phải dạng "Bearer <token>"'));
    try {
      const user = await provider.verify(m[1].trim());
      if (!user) return next(Errors.unauthorized('Token không hợp lệ hoặc đã hết hạn'));
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(Errors.unauthorized());
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(Errors.unauthorized());
  if (req.user.role !== 'admin') return next(Errors.forbidden('Chỉ quản trị viên mới được thực hiện thao tác này'));
  next();
};

/** Dùng trong handler sau requireAuth */
export function currentUser(req: { user?: AuthUser }): AuthUser {
  if (!req.user) throw Errors.unauthorized();
  return req.user;
}
