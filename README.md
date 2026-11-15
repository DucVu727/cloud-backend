# Backend quản lý sự kiện & đặt vé (GCP)

Dịch vụ sở hữu **dữ liệu đơn chính thức** của hệ thống: sự kiện, hạng vé, đơn đặt vé.
Mọi thay đổi đơn (đặt / hủy) được ghi kèm một sự kiện vào **outbox** trong cùng giao dịch,
rồi worker gửi sang Azure (phần thống kê) và tự động gửi lại khi Azure lỗi.

- Node.js 22 + TypeScript + Express 5
- PostgreSQL 16 (Cloud SQL khi triển khai trên GCP)
- Zod (kiểm tra dữ liệu), Vitest + Supertest (kiểm thử trên Postgres thật)

Tài liệu khác:
- [docs/API.md](docs/API.md): danh sách API, request/response, mã lỗi (cho frontend)
- [docs/azure-message-contract.md](docs/azure-message-contract.md): mẫu thông điệp và API thống kê thống nhất với người làm Azure
- [docs/BAO-CAO.md](docs/BAO-CAO.md): báo cáo phần đã làm

---

## 1. Khởi chạy nhanh (local)

Yêu cầu: Node.js ≥ 20, Docker Desktop.

```bash
# 1. Cài thư viện
npm install

# 2. Cấu hình (mặc định chạy được ngay với Postgres trong docker-compose)
cp .env.example .env

# 3. Bật PostgreSQL (tự tạo 2 DB: ticketing và ticketing_test)
docker compose up -d db

# 4. Tạo bảng + dữ liệu mẫu
npm run migrate
npm run seed            # hoặc: npm run seed -- --reset  (xóa sạch rồi seed lại)

# 5. Chạy API (tự reload khi sửa code)
npm run dev             # http://localhost:3000
```

Kiểm tra: `curl http://localhost:3000/health`

### Trang test thủ công: http://localhost:3000/dev

Đây là một file HTML duy nhất ([dev-console/index.html](dev-console/index.html)), **không phải frontend thật**. Trang này chỉ bật khi
`NODE_ENV` không phải `production` (có thể ép bật/tắt bằng `DEV_CONSOLE=true/false`) và không được đóng vào Docker image.

| Tab | Thử được gì |
|---|---|
| Sự kiện & đặt vé | Lọc theo loại hình, xem hạng vé và số còn lại, đặt vé, giả lập bấm "Đặt" 2 lần (Idempotency-Key), **test tranh vé đồng thời** (N khách bắn cùng lúc) |
| Đơn của tôi | Danh sách và hủy đơn (hủy lần 2 thì nhận 409, quá hạn thì nhận 422), dán ID đơn của người khác để thử quyền truy cập (404) |
| Quản trị | Tạo và sửa sự kiện, hạng vé (thử giá âm, giảm vé dưới số đang giữ), tra đơn theo sự kiện và trạng thái, admin hủy đơn |
| Outbox & thống kê | PENDING/SENT/FAILED, chạy worker, gửi lại; xem thống kê |

Đổi người dùng ở góc trên bên phải (alice, bob, carol, admin1). Cột bên phải ghi lại mọi request và response.
Để thử "gửi sang Azure thất bại", chạy server với `PUBLISHER_MOCK_FAIL=true`, đặt vài vé, sau đó tắt cờ và khởi động lại để thấy worker tự gửi lại.

### Dữ liệu mẫu do `npm run seed` tạo

| Sự kiện | Loại hình | Ghi chú |
|---|---|---|
| Đêm nhạc Mùa Đông 2026 | concert | 3 hạng vé, trong đó **VVIP chỉ có 1 vé** để thử "tranh vé cuối" |
| Chung kết Giải bóng đá Sinh viên | sport | 2 hạng vé |
| Hội thảo Cloud Native Việt Nam | conference | có hạng vé giá 0đ |
| Kịch: Hồn Trương Ba, da hàng thịt | theater | diễn sau **12 giờ**, dùng để thử "quá hạn hủy" |
| Lễ hội Ẩm thực đường phố | festival | **DRAFT**: khách không thấy |

Kèm 3 đơn mẫu (alice ×2, bob ×1), trong đó 1 đơn đã hủy.

### Đăng nhập khi chưa có Backend tài khoản (`AUTH_MODE=mock`)

Gửi header `Authorization: Bearer mock:<userId>:<role>`:

```bash
# khách
curl -H "Authorization: Bearer mock:alice:customer" http://localhost:3000/api/orders
# quản trị
curl -H "Authorization: Bearer mock:admin1:admin" http://localhost:3000/api/admin/orders
```

### Chạy kiểm thử

```bash
docker compose up -d db
npm test
```

Test dùng DB `ticketing_test` (đặt bởi `TEST_DATABASE_URL`). DB này **bị xóa dữ liệu** mỗi lần chạy test.

---

## 2. Biến môi trường chính

Xem đầy đủ trong [.env.example](.env.example).

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | postgres://…/ticketing | Chuỗi kết nối Postgres |
| `AUTH_MODE` | `mock` | `mock` \| `jwt` \| `http` (xem mục 3) |
| `CANCELLATION_DEADLINE_HOURS` | `24` | Khách chỉ được hủy khi còn ≥ N giờ trước giờ diễn |
| `MAX_TICKETS_PER_ORDER` | `10` | Số vé tối đa mỗi đơn |
| `PUBLISHER_MODE` | `mock` | `mock` (kiểm tra mẫu thông điệp rồi ghi log) \| `azure-queue` (gửi vào Azure Storage Queue) |
| `AZURE_QUEUE_SAS_URL` | | **Bí mật.** URL queue `ticket-events` kèm SAS (chỉ quyền ghi, hết hạn 15/01/2027) |
| `PUBLISHER_MOCK_FAIL` | `false` | Giả lập Azure lỗi để thử cơ chế gửi lại |
| `OUTBOX_POLL_INTERVAL_MS` | `5000` | Chu kỳ worker quét outbox |
| `OUTBOX_MAX_ATTEMPTS` | `10` | Quá số lần thử thì chuyển sang FAILED, chờ admin gửi lại |
| `STATS_MODE` | `mock` | `mock` (giả lập API `/stats` của Azure từ DB cục bộ) \| `http` (đọc từ `AZURE_STATS_URL`) |
| `AZURE_STATS_KEY` | | **Bí mật.** `x-functions-key` của API thống kê, chỉ backend giữ |

Chạy thử kết nối Azure thật (sau khi điền 3 biến Azure vào `.env`): `npm run azure:smoke`. Chi tiết xem [docs/azure-message-contract.md](docs/azure-message-contract.md).

---

## 3. Tích hợp Backend tài khoản

Mã nguồn: [src/auth/providers.ts](src/auth/providers.ts). Chọn chế độ bằng `AUTH_MODE`:

| Chế độ | Cách hoạt động | Cần thống nhất với người làm Backend tài khoản |
|---|---|---|
| `mock` | Token dạng `mock:<userId>:<role>` | Không cần (chỉ dùng để phát triển và test) |
| `jwt` | Tự verify JWT bằng `AUTH_JWT_SECRET` (HS256) hoặc `AUTH_JWT_PUBLIC_KEY` (RS256) | Secret/public key; claim `sub` (hoặc `userId`) và `role` (hoặc `roles`) |
| `http` | Gọi `GET {AUTH_SERVICE_URL}{AUTH_VERIFY_PATH}` kèm header Authorization của người dùng | Endpoint trả `{ id, role }`, hoặc 401 nếu token không hợp lệ |

Quyền quản trị = `role === "admin"` (hoặc mảng `roles` có chứa `"admin"`).
Nếu dịch vụ tài khoản không phản hồi, API trả `503 AUTH_SERVICE_UNAVAILABLE`.

---

## 4. Triển khai lên GCP (Cloud Run + Cloud SQL)

### 4.1. Biến môi trường khi chạy thật

| Biến | Giá trị | Bí mật? |
|---|---|---|
| `DATABASE_URL` | `postgres://USER:PASS@/ticketing?host=/cloudsql/PROJECT:REGION:INSTANCE` | ✔ (chứa mật khẩu) |
| `PUBLISHER_MODE` | `azure-queue` | |
| `AZURE_QUEUE_SAS_URL` | `https://stticketsinh2026.queue.core.windows.net/ticket-events?<SAS>` (có `/messages` hay không đều được). **Không** dùng `AZURE_QUEUE_NAME` hay connection string | ✔ |
| `STATS_MODE` | `http` | |
| `AZURE_STATS_URL` | `https://func-ticket-stats-sinh.azurewebsites.net/api`: **địa chỉ gốc**, backend tự nối thêm `/stats?...` và `/history?...` | |
| `AZURE_STATS_KEY` | `x-functions-key` của API thống kê | ✔ |
| `AUTH_MODE` | `mock` cho tới khi Backend tài khoản chốt cách xác thực. Nếu dùng `jwt` thì **bắt buộc** có `AUTH_JWT_SECRET`, không có thì server không khởi động | |
| `DEV_CONSOLE` | `true` nếu muốn mở trang test `/dev` trên bản deploy (mặc định tắt ở production) | |

> ⚠ `AUTH_MODE=mock` nghĩa là **ai có URL cũng tự xưng được là admin** (`Bearer mock:x:admin`). Chỉ chấp nhận được khi demo; phải đổi trước khi dùng thật.

### 4.2. Build và deploy

```bash
# Build image và đẩy lên Artifact Registry
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/ticketing/api

# Lưu bí mật vào Secret Manager (1 lần)
printf '%s' 'postgres://USER:PASS@/ticketing?host=/cloudsql/PROJECT:REGION:INSTANCE' | gcloud secrets create ticketing-db-url --data-file=-
printf '%s' '<URL queue kèm SAS>' | gcloud secrets create azure-queue-sas --data-file=-
printf '%s' '<x-functions-key>'   | gcloud secrets create azure-stats-key --data-file=-

# Deploy (Cloud SQL Postgres đã tạo sẵn, có database "ticketing")
gcloud run deploy ticketing-api \
  --image REGION-docker.pkg.dev/PROJECT/ticketing/api \
  --add-cloudsql-instances PROJECT:REGION:INSTANCE \
  --set-env-vars "AUTH_MODE=mock,PUBLISHER_MODE=azure-queue,STATS_MODE=http,AZURE_STATS_URL=https://func-ticket-stats-sinh.azurewebsites.net/api" \
  --set-secrets "DATABASE_URL=ticketing-db-url:latest,AZURE_QUEUE_SAS_URL=azure-queue-sas:latest,AZURE_STATS_KEY=azure-stats-key:latest" \
  --min-instances 1 --no-cpu-throttling \
  --allow-unauthenticated
```

- **`--no-cpu-throttling` và `--min-instances 1` là bắt buộc.** Worker outbox chạy ngầm trong cùng tiến trình. Nếu Cloud Run chỉ cấp CPU khi có request (mặc định), worker sẽ bị dừng và dữ liệu không được gửi sang Azure.
- Container tự chạy migration khi khởi động. Migration dùng advisory lock nên nhiều instance khởi động cùng lúc vẫn an toàn.
- Nhiều instance chạy song song không gửi trùng (dùng `FOR UPDATE SKIP LOCKED` kèm lease).
- Kiểm tra sau khi deploy: `curl https://<URL Cloud Run>/health` phải trả `{"status":"ok","db":"ok","auth":"mock","publisher":"azure-queue"}`.

### 4.3. Seed dữ liệu demo lên Cloud SQL

Seed tạo 5 sự kiện và 3 đơn mẫu (1 đơn đã hủy). Khi service đang chạy ở chế độ `azure-queue`, worker sẽ gửi các đơn này sang Azure, nên số vé ở Azure khớp với doanh thu trong DB.

```bash
gcloud run jobs create ticketing-seed \
  --image REGION-docker.pkg.dev/PROJECT/ticketing/api \
  --add-cloudsql-instances PROJECT:REGION:INSTANCE \
  --set-secrets "DATABASE_URL=ticketing-db-url:latest" \
  --command node --args dist/scripts/seed.js
gcloud run jobs execute ticketing-seed --wait
```

- Seed **chỉ chạy khi DB chưa có sự kiện nào**, nên chạy lại cũng không sao.
- Muốn làm lại từ đầu thì thêm `--args dist/scripts/seed.js,--reset`. ⚠ Lệnh này **xóa toàn bộ** sự kiện, đơn và outbox. Nếu đã gửi dữ liệu sang Azure trước đó, phải nhờ bên Azure xóa phía họ trước, nếu không số liệu sẽ lệch.
- Sau khi seed khoảng 1–2 phút, kiểm tra: `GET /api/admin/outbox/stats` (header `Authorization: Bearer mock:admin1:admin`) phải cho thấy `SENT: 4`, `PENDING: 0`, `FAILED: 0`.

### 4.4. Lưu ý khi chạy song song máy local và bản deploy

Máy local và bản deploy dùng **cùng một queue Azure**. Khi đã có bản deploy, đặt `PUBLISHER_MODE=mock` trong `.env` ở máy local, để dữ liệu test trên máy không lẫn vào số liệu demo.

---

## 5. Cấu trúc mã nguồn

```
migrations/001_init.sql     Schema: events, ticket_types, orders, outbox_events
src/
  app.ts, server.ts         Dựng Express app, khởi động server và worker
  config.ts, db.ts          Cấu hình, pool Postgres, withTransaction()
  errors.ts                 AppError, middleware xử lý lỗi thống nhất
  auth/                     Adapter Backend tài khoản (mock/jwt/http) và middleware phân quyền
  events/                   Sự kiện và hạng vé: schema validate, service
  orders/                   Đặt, hủy, tra đơn (giao dịch, chống bán vượt)
  outbox/                   Thông điệp nội bộ, mẫu và validator Azure, gửi qua Storage Queue, worker gửi lại
  stats/                    Đọc /stats và /history của Azure, ghép doanh thu từ DB (timeout, retry, cache, stale)
  routes.ts                 Khai báo toàn bộ route
  scripts/                  migrate.ts, seed.ts
tests/                      38 test tích hợp chạy trên Postgres thật
```
