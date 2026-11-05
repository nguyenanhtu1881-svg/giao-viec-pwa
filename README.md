# Giao Việc PWA

PWA tiếng Việt cho tiếp nhận xe và điều phối kỹ thuật viên. Frontend dùng HTML/CSS/JavaScript; Supabase cung cấp Auth, PostgreSQL, RLS, Storage riêng tư và Realtime.

## Luồng dữ liệu

- `vehicle_intakes`: ảnh phiếu và thông tin tại thời điểm tiếp nhận.
- `work_orders`: một đợt sửa chữa gắn với một hồ sơ tiếp nhận.
- `work_assignments`: một dòng cho mỗi kỹ thuật viên trong work order; trạng thái độc lập gồm `todo`, `doing`, `paused`, `done`.
- `work_assignment_events`: lịch sử bất biến của các lần đổi trạng thái.
- Xe tự hoàn tất khi có ít nhất một phân công và mọi phân công đều hoàn tất. Admin có thể xác nhận hoàn tất ngoại lệ kèm lý do.
- Hồ sơ chỉ đủ điều kiện lưu trữ khi work order đã hoàn tất ít nhất 45 ngày. Scheduled Edge Function xóa ảnh khỏi Storage trước, sau đó mới xóa hồ sơ và dữ liệu con.

Bảng `tasks` cũ vẫn dùng cho các việc chung; migration mới không xóa hay chuyển đổi dữ liệu của bảng này.

## Supabase

Các migration nằm trong `supabase/migrations`. Bốn migration ngày 03/11 được phục hồi từ lịch sử SQL của dự án đang kết nối. Migration `20261102000000_core_task_schema.sql` khôi phục schema nền `profiles`/`tasks`; nó có phiên bản cũ hơn bốn migration đã chạy trên dự án thật. Migration `20261105090000_vehicle_multi_technician_workflow.sql` thêm workflow nhiều kỹ thuật viên; `20261105100000_harden_api_security_definers.sql` chuyển helper phân quyền và thao tác cập nhật nhạy cảm vào schema `private`, để API công khai chỉ có wrapper `SECURITY INVOKER`, không cấp quyền cập nhật trực tiếp task hoặc DML trực tiếp trên workflow. Quyền tạo task và tiếp nhận xe được giới hạn theo cột.

Migration bootstrap `20261102000000` chưa có trong lịch sử migration của project hiện tại, trong khi bốn migration intake đã được ghi nhận. Vì vậy hãy đối chiếu `supabase migration list --remote` và schema trước khi `db push --dry-run`. Nếu bootstrap đã được áp dụng thủ công thì chỉ sửa lịch sử bằng `supabase migration repair --status applied 20261102000000` sau khi xác minh đầy đủ các đối tượng nó tạo; nếu định chạy migration cũ còn thiếu, CLI cần `--include-all`. Không áp dụng lựa chọn nào lên project đang vận hành trước khi thử trên môi trường phát triển và duyệt dry run.

Với project mới, làm theo [hướng dẫn Supabase](supabase/README.md) để đăng ký và kích hoạt Admin chính một lần. Frontend chỉ được chứa URL và publishable/anon key; tuyệt đối không đặt service role key hoặc secret lịch chạy vào mã trình duyệt.

## Kiểm tra

Yêu cầu Node.js 24 trở lên. Chạy:

```sh
node --test
node --check app.js
node --check sw.js
node --check supabase/functions/retention-cleanup/index.js
```

Các test này kiểm tra tham chiếu DOM, hành vi offline/cache của service worker, một số bất biến bảo mật trong migration và thứ tự/xử lý lỗi của retention function. Chúng không thay cho kiểm thử RLS, Storage, Auth hoặc chạy migration trên Supabase development project.

Để kiểm thử thêm SQL workflow trên PostgreSQL WASM cục bộ (không kết nối Supabase), cài PGlite tạm và chạy:

```sh
npm install --no-save @electric-sql/pglite
node tests/pglite-migrations.mjs
```

Harness dùng các bảng/function Auth và Storage giả lập. Nó bỏ riêng khối `ALTER PUBLICATION` vì PGlite không hỗ trợ publication; cần kiểm tra Realtime trên Supabase thật trước khi phát hành.

## Trước khi phát hành

Kiểm thử đăng nhập bằng Admin chính, Admin thứ hai, nhân viên tiếp nhận và kỹ thuật viên; kiểm tra nhiều người cùng cập nhật một xe, tạm dừng bắt buộc có lý do, hoàn tất tổng thể, phân quyền Storage, cập nhật Realtime và email khôi phục. Trên Supabase Dashboard, vào **Authentication → Providers → Email** và bật mục ngăn sử dụng mật khẩu bị lộ (hiện đang tắt trên project đã kiểm tra). Tính năng này yêu cầu gói Pro trở lên; xem [Supabase Password security](https://supabase.com/docs/guides/auth/password-security). Triển khai Edge Function và lịch chạy retention riêng sau khi cấu hình secrets trên Supabase.
