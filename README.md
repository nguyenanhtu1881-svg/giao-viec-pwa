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

Các migration nằm trong `supabase/migrations`. Bốn migration ngày 03/11 được phục hồi từ lịch sử SQL của dự án đang kết nối. Migration `20261102000000_core_task_schema.sql` khôi phục schema nền `profiles`/`tasks`; nó có phiên bản cũ hơn bốn migration đã chạy trên dự án thật. Migration workflow mới là `20261105090000_vehicle_multi_technician_workflow.sql`.

Trước khi áp dụng migration vào bất kỳ project nào, xem lịch sử bằng Supabase CLI và kiểm tra `db push --dry-run`. Không chạy migration mới trực tiếp lên project đang vận hành trước khi review kết quả dry run và thử trên môi trường phát triển.

Với project mới, làm theo [hướng dẫn Supabase](supabase/README.md) để đăng ký và kích hoạt Admin chính một lần. Frontend chỉ được chứa URL và publishable/anon key; tuyệt đối không đặt service role key hoặc secret lịch chạy vào mã trình duyệt.

## Kiểm tra

Yêu cầu Node.js 24 trở lên. Chạy:

```sh
node --test
node --check app.js
node --check sw.js
node --check supabase/functions/retention-cleanup/index.js
```

Các test này kiểm tra tham chiếu DOM, cấu trúc migration và thứ tự/xử lý lỗi của retention function. Chúng không thay cho kiểm thử RLS, Storage, Auth hoặc chạy migration trên Supabase development project.

## Trước khi phát hành

Kiểm thử đăng nhập bằng Admin chính, Admin thứ hai, nhân viên tiếp nhận và kỹ thuật viên; kiểm tra nhiều người cùng cập nhật một xe, tạm dừng bắt buộc có lý do, hoàn tất tổng thể, phân quyền Storage, cập nhật Realtime và email khôi phục. Triển khai Edge Function và lịch chạy retention riêng sau khi cấu hình secrets trên Supabase.

