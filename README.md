# Backend quản lý sự kiện & đặt vé (GCP)

> Bản chạy trên GCP dùng JWT, `DB_POOL_MAX=5`, `STATS_TIMEOUT_MS=60000`, `CORS_ORIGIN` nhiều origin cách nhau bằng dấu phẩy và `OUTBOX_BATCH_SIZE=1` (xem mục 4.1). Bộ test có 66 test. Script triển khai riêng của project GCP do Dương quản lý.

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
`NODE_ENV` không phải `production` (có thể ép bật/tắt bằng `DEV_CONSOLE=true/false`). File có trong Docker image nhưng bản cloud đặt `DEV_CONSOLE=false`.

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

### Tạo token test khi `AUTH_MODE=jwt`

Bản cloud **không nhận** token `mock:`. Để thử API, tạo JWT ngắn hạn (HS256, claim `sub` và `role`) bằng cùng secret mà server dùng:

```powershell
# nạp secret vào biến môi trường của phiên terminal, KHÔNG ghi ra file
$env:AUTH_JWT_SECRET = gcloud secrets versions access 1 --secret=ticket-jwt-secret
$token = npm run --silent token -- --sub admin1 --role admin --ttl 30
curl.exe -H "Authorization: Bearer $token" https://ticket-api-5iqotxgmrq-as.a.run.app/api/me
Remove-Item Env:AUTH_JWT_SECRET
```

Script chỉ in token ra màn hình. Không dán token vào log, tài liệu hay repo. Token hết hạn sau `--ttl` phút (mặc định 60).

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
| `DB_POOL_MAX` | `5` | Số kết nối tối đa tới Postgres (Cloud SQL `db-f1-micro` dùng chung nên để nhỏ) |
| `CORS_ORIGIN` | `*` | Một origin hoặc danh sách cách nhau bằng dấu phẩy (URL các frontend) |
| `AUTH_MODE` | `mock` | `mock` \| `jwt` \| `http` (xem mục 3) |
| `CANCELLATION_DEADLINE_HOURS` | `24` | Khách chỉ được hủy khi còn ≥ N giờ trước giờ diễn |
| `MAX_TICKETS_PER_ORDER` | `10` | Số vé tối đa mỗi đơn |
| `PUBLISHER_MODE` | `mock` | `mock` (kiểm tra mẫu thông điệp rồi ghi log) \| `azure-queue` (gửi vào Azure Storage Queue) |
| `AZURE_QUEUE_SAS_URL` | | **Bí mật.** URL queue `ticket-events` kèm SAS (chỉ quyền ghi, hết hạn 15/01/2027) |
| `PUBLISHER_MOCK_FAIL` | `false` | Giả lập Azure lỗi để thử cơ chế gửi lại |
| `OUTBOX_POLL_INTERVAL_MS` | `5000` | Chu kỳ worker quét outbox |
| `OUTBOX_BATCH_SIZE` | `20` | Số thông điệp worker nhận mỗi lượt |
| `OUTBOX_LEASE_MS` | lô × `AZURE_TIMEOUT_MS` + 30s, tối thiểu 60s | Thời gian một lượt worker giữ lô đã nhận. Thường không cần đặt |
| `OUTBOX_MAX_ATTEMPTS` | `10` | Quá số lần thử thì chuyển sang FAILED, chờ admin gửi lại. Mức 10 ≈ 36 phút Azure lỗi liên tục, mức 20 ≈ 3 giờ |
| `STATS_TIMEOUT_MS` | `60000` | Thời gian chờ API thống kê (Azure Function có thể khởi động chậm). Lỗi tạm thời được thử lại 1 lần |
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

Cấu hình đang chạy trên service `ticket-api` (Dương quản lý, cập nhật 16/11/2026). Biến bí mật lấy từ Secret Manager, **không** có trong repo hay `.env`:

| Biến | Giá trị | Nguồn |
|---|---|---|
| `DATABASE_URL` | DB `ticketdb`, user `ticket_backend`, qua socket Cloud SQL `ticket-cloud-514604:asia-southeast1:ticket-db` | Secret `ticket-db-backend-url` |
| `AUTH_MODE` | `jwt` (HS256) | |
| `AUTH_JWT_SECRET` | | Secret `ticket-jwt-secret` |
| `CORS_ORIGIN` | URL của `ticket-web` và `ticket-admin`, cách nhau bằng dấu phẩy | |
| `DB_POOL_MAX` | `5` | |
| `NODE_ENV` / `DEV_CONSOLE` | `production` / `false` | |
| `PUBLISHER_MODE` | `azure-queue` | |
| `AZURE_QUEUE_SAS_URL` | URL queue `ticket-events` kèm SAS (có `/messages` hay không đều được). **Không** dùng `AZURE_QUEUE_NAME` hay connection string | Secret `azure-queue-url` |
| `AZURE_TIMEOUT_MS` | `5000` | |
| `OUTBOX_ENABLED` / `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` | `true` / `5000` / `1` | |
| `STATS_MODE` | `http` | |
| `AZURE_STATS_URL` | `https://func-ticket-stats-sinh.azurewebsites.net/api`: **địa chỉ gốc**, backend tự nối thêm `/stats?...` và `/history?...` | |
| `AZURE_STATS_KEY` | `x-functions-key` của API thống kê | Secret `azure-stats-key` |
| `STATS_TIMEOUT_MS` | `60000` (request timeout của Cloud Run là 180s, đủ cho 2 lần thử) | |

Các biến không khai báo dùng mặc định ở mục 2 (`CANCELLATION_DEADLINE_HOURS=24`, `MAX_TICKETS_PER_ORDER=10`, `OUTBOX_MAX_ATTEMPTS=10`...). `PORT` do Cloud Run tự đặt.
**Không** đặt `AUTH_JWT_PUBLIC_KEY`: nếu có giá trị, server chuyển sang RS256 và bỏ qua `AUTH_JWT_SECRET`.

> ⚠ Không chép các biến này vào `.env` ở máy local. Máy local dùng `AUTH_MODE=mock` và `PUBLISHER_MODE=mock` (xem 4.4).
> ⚠ `AUTH_MODE=mock` nghĩa là **ai có URL cũng tự xưng được là admin** (`Bearer mock:x:admin`). Không bao giờ dùng trên bản cloud.

### 4.2. Build và deploy

Project của nhóm deploy bằng script của Dương trong `ticket-cloud` (`build-duc-backend.ps1`, `deploy-duc-backend.ps1`, `verify-duc-backend.mjs`). Các lệnh dưới đây là cách làm tổng quát khi tự deploy ở project khác:

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
  --set-env-vars "NODE_ENV=production,AUTH_MODE=jwt,PUBLISHER_MODE=azure-queue,STATS_MODE=http,AZURE_STATS_URL=https://func-ticket-stats-sinh.azurewebsites.net/api,DB_POOL_MAX=5,STATS_TIMEOUT_MS=60000" \
  --set-secrets "DATABASE_URL=ticketing-db-url:latest,AUTH_JWT_SECRET=jwt-secret:latest,AZURE_QUEUE_SAS_URL=azure-queue-sas:latest,AZURE_STATS_KEY=azure-stats-key:latest" \
  --min-instances 1 --max-instances 1 --no-cpu-throttling --cpu-boost --timeout 180 \
  --allow-unauthenticated
```

- **`--no-cpu-throttling` và `--min-instances 1` là bắt buộc.** Worker outbox chạy ngầm trong cùng tiến trình. Nếu Cloud Run chỉ cấp CPU khi có request (mặc định), worker sẽ bị dừng và dữ liệu không được gửi sang Azure.
- Container tự chạy migration khi khởi động (`exec` để Node nhận SIGTERM và tắt êm). Migration dùng advisory lock nên nhiều instance khởi động cùng lúc vẫn an toàn.
- Migration **không cần quyền tạo extension**: `gen_random_uuid()` có sẵn từ PostgreSQL 13. User ứng dụng chỉ cần quyền trên schema của mình.
- Migration `003` chỉ thêm một cột cho phép NULL, nên chạy được trên DB đã có dữ liệu và trong lúc revision cũ còn phục vụ.
- Nhiều worker chạy song song không gửi trùng: `FOR UPDATE SKIP LOCKED`, lease và mã nhận việc `claim_token`.
- Kiểm tra sau khi deploy: `curl https://<URL Cloud Run>/health` phải trả `{"status":"ok","db":"ok","auth":"jwt","publisher":"azure-queue"}`.

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
- Sau khi seed khoảng 1–2 phút, kiểm tra: `GET /api/admin/outbox/stats` (header `Authorization: Bearer <token admin>`, tạo token như mục 1) phải cho thấy `SENT: 4`, `PENDING: 0`, `FAILED: 0`.

### 4.4. Lưu ý khi chạy song song máy local và bản deploy

Máy local và bản deploy dùng **cùng một queue Azure**. Khi đã có bản deploy, đặt `PUBLISHER_MODE=mock` trong `.env` ở máy local, để dữ liệu test trên máy không lẫn vào số liệu demo.

### 4.5. Log minh chứng (Cloud Logging)

Mỗi lần gọi Azure **thành công**, backend ghi một dòng JSON. `httpStatus` là mã Azure thật sự trả về:

```json
{"severity":"INFO","event":"azure_queue_send_succeeded","httpStatus":201,"eventId":"…","orderId":"…","messageId":"…","messageType":"BOOKED"}
{"severity":"INFO","event":"azure_stats_request_succeeded","httpStatus":200,"path":"/stats","groupBy":"event","eventId":"…"}
{"severity":"INFO","event":"azure_stats_request_succeeded","httpStatus":200,"path":"/history","orderId":"…"}
```

- Log `/stats` chỉ ghi khi Azure trả dữ liệu đúng định dạng. Kết quả lấy từ cache không ghi log, nên không có dòng 200 giả.
- Log không bao giờ chứa URL kèm SAS, function key, JWT hay header Authorization (có test kiểm tra).
- Lọc trong Logs Explorer: `jsonPayload.event="azure_queue_send_succeeded"` hoặc `jsonPayload.event="azure_stats_request_succeeded"`.

---

## 5. Cấu trúc mã nguồn

```
migrations/001_init.sql     Schema: events, ticket_types, orders, outbox_events
migrations/002, 003         outbox_events.sent_via (kênh đã gửi), outbox_events.claim_token (mã nhận việc của worker)
src/
  app.ts, server.ts         Dựng Express app, khởi động server và worker
  config.ts, db.ts          Cấu hình, pool Postgres, withTransaction()
  errors.ts                 AppError, middleware xử lý lỗi thống nhất
  auth/                     Adapter Backend tài khoản (mock/jwt/http) và middleware phân quyền
  events/                   Sự kiện và hạng vé: schema validate, service (hủy sự kiện => hủy mọi đơn)
  orders/                   Đặt, hủy, tra đơn (giao dịch, chống bán vượt)
  outbox/                   Thông điệp nội bộ, mẫu và validator Azure, gửi qua Storage Queue, worker gửi lại
  stats/                    Đọc /stats và /history của Azure, ghép doanh thu từ DB (timeout, retry, cache, stale)
  lib/log.ts                Log JSON một dòng cho Cloud Logging
  routes.ts                 Khai báo toàn bộ route
  scripts/                  migrate, seed, make-token (JWT test), azure-smoke, azure-sent-report
tests/                      66 test tích hợp chạy trên Postgres thật
```
