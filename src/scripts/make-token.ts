import { parseArgs } from 'node:util';
import jwt from 'jsonwebtoken';
import { config } from '../config';

/**
 * Tạo JWT ngắn hạn để thử API khi AUTH_MODE=jwt (HS256, claim giống backend đang đọc: sub + role).
 *
 *   npm run token -- --sub admin1 --role admin [--ttl 60] [--email a@b.c] [--name "Admin"]
 *
 * Secret lấy từ biến môi trường AUTH_JWT_SECRET (hoặc .env). Để dùng secret trên cloud mà không
 * ghi ra file, nạp thẳng từ Secret Manager vào biến môi trường của phiên terminal:
 *   PowerShell: $env:AUTH_JWT_SECRET = gcloud secrets versions access 1 --secret=ticket-jwt-secret
 *
 * Script CHỈ in token ra stdout. Không lưu token vào file, log hay repo.
 */
function main(): void {
  const { values } = parseArgs({
    options: {
      sub: { type: 'string' },
      role: { type: 'string', default: 'customer' },
      ttl: { type: 'string', default: '60' },
      email: { type: 'string' },
      name: { type: 'string' },
    },
  });

  const secret = config.auth.jwtSecret;
  if (!secret) fail('Thiếu AUTH_JWT_SECRET (đặt trong biến môi trường hoặc .env).');
  if (!values.sub) fail('Thiếu --sub <userId>.');
  if (values.role !== 'admin' && values.role !== 'customer') fail('--role phải là admin hoặc customer.');
  const ttlMinutes = Number(values.ttl);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 24 * 60) fail('--ttl là số phút, từ 1 đến 1440.');

  const token = jwt.sign(
    { sub: values.sub, role: values.role, ...(values.email ? { email: values.email } : {}), ...(values.name ? { name: values.name } : {}) },
    secret,
    { algorithm: 'HS256', expiresIn: ttlMinutes * 60 },
  );
  process.stdout.write(`${token}\n`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main();
