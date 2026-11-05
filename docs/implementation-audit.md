# Đối chiếu bàn giao và tình trạng nghiệm thu

Ngày đối chiếu: 05/11/2026. Phạm vi kiểm tra gồm nhánh review và Supabase project đã kết nối. Migration chưa được chạy trên project.

| Yêu cầu | Triển khai trong nhánh review | Bằng chứng / trạng thái |
|---|---|---|
| Đăng ký nhân viên mặc định chờ Admin kích hoạt; chỉ Admin chính quản lý tài khoản và phân quyền Admin | Luồng tài khoản giữ trạng thái chờ kích hoạt; UI phân quyền hệ thống/work role; trigger bảo vệ email, role và active của Admin chính | Có kiểm thử cú pháp/cấu trúc. Chưa thử đăng nhập bằng từng loại tài khoản thật. |
| Tiếp nhận ảnh báo giá hoặc phiếu kiểm tra; OCR chỉ gợi ý; người dùng xác nhận biển số | Biểu mẫu yêu cầu chọn một trong hai loại phiếu; OCR chỉ điền gợi ý; người tiếp nhận phải đánh dấu đã đối chiếu biển số. Xác nhận được lưu vào `plate_confirmed`, RLS yêu cầu `true` cho lần tiếp nhận mới; hàng đợi cảnh báo hồ sơ cũ thiếu xác nhận. Đổi ảnh/biển số sẽ xóa xác nhận trên biểu mẫu. | Có kiểm thử tĩnh cho loại phiếu, payload, cột DB và chính sách RLS. Chưa thử camera/tải ảnh trên điện thoại hoặc chạy migration trên DB thử nghiệm. |
| Lưu biển số, loại chứng từ, trạm, người tiếp nhận và thời điểm | Các cột ở `vehicle_intakes`; FK `vehicle_intakes_received_by_fkey` đã được xác minh trên project hiện tại | Cấu trúc live đã đọc; chưa chạy lại migrations từ đầu. |
| Admin xem hàng đợi và cảnh báo biển số trùng đang xử lý | Hàng đợi xếp theo thời gian; cảnh báo so khớp biển số đã chuẩn hóa, chỉ tính hồ sơ chưa đóng | Có kiểm tra DOM/cấu trúc. Chưa thử với dữ liệu vận hành. |
| Một xe giao cho nhiều kỹ thuật viên, mỗi người có trạng thái riêng | `work_orders` 1:1 với intake; `work_assignments` duy nhất theo work order/kỹ thuật viên; trạng thái `todo`, `doing`, `paused`, `done` | Test kiểm tra constraint và policies tĩnh; chưa áp dụng migration lên database thử nghiệm. |
| Tạm dừng cần lý do; lưu lịch sử từng thay đổi | CHECK constraint yêu cầu lý do; trigger ghi `work_assignment_events`; UI không cho gửi tạm dừng khi thiếu lý do | Test kiểm tra cấu trúc SQL và hành vi UI tĩnh; chưa chạy SQL thực tế. |
| Xe tự hoàn thành khi mọi phân công xong; Admin có thể hoàn thành ngoại lệ | Trigger tổng hợp trạng thái work order/intake; RPC ngoại lệ yêu cầu lý do và ghi sự kiện | SQL và RPC có trong migration; chưa chạy tích hợp. |
| Theo dõi tiến độ tổng thể và theo từng kỹ thuật viên theo thời gian thực | Màn hình work orders đọc từng assignment; Realtime đăng ký `work_orders`, `work_assignments`, `vehicle_intakes` | Cấu hình publication có trong migration; chưa xác minh subscription trong app đang chạy. |
| Ảnh và hồ sơ hoàn tất giữ tối đa 45 ngày; không xóa hồ sơ chưa xong | Hàm claim chỉ chọn work order đã hoàn tất đủ 45 ngày và intake đã đóng; Edge Function xóa Storage trước, sau đó xóa hồ sơ | 3 test retention mock đạt; Edge Function và lịch chạy chưa được deploy/cấu hình. |
| RLS, quyền Storage và hàm đặc quyền được rà soát | Migration khôi phục bốn migration đã áp dụng, đưa helper/write RPC nhạy cảm sang schema `private`, thu hồi quyền DML dư thừa, giữ wrapper public `SECURITY INVOKER` | Audit chỉ đọc phát hiện ACL rộng trên project. Migration khắc phục nằm trong PR nhưng chưa áp dụng; advisory live vẫn phản ánh trạng thái cũ. |
| Auth đăng nhập, khôi phục mật khẩu và bảo vệ mật khẩu bị lộ | Listener Auth đăng ký sớm và xử lý `PASSWORD_RECOVERY`; Auth settings hiện vẫn tắt kiểm tra mật khẩu bị lộ | Chưa thử email khôi phục thực tế; mục bảo vệ mật khẩu cần bật trong Supabase Auth settings. |
| Migration khớp lịch sử project | Bốn migration ngày 03/11 khôi phục từ lịch sử SQL live; migration bootstrap `20261102000000` bổ sung schema nền chưa có trong history live | Remote hiện ghi nhận bốn migration intake. Cần đối chiếu bootstrap trước `db push`; hướng dẫn ở README. |
| Bảo toàn `main`, production và chuẩn bị review | Thay đổi nằm trong PR nháp #2, nhắm `feature/intake-foundation` | PR mở, chưa merge; không có migration hoặc deploy production từ Codex. |

## Kiểm tra đã chạy

- `node --check app.js`, `node --check sw.js`, `node --check supabase/functions/retention-cleanup/index.js`
- `node --test`: 10 bài đạt
- `git diff --check`
- GitHub Actions `Validate` thành công cho commit review hiện tại

Các kiểm tra trên không thay thế chạy migrations, kiểm tra RLS/Storage/Auth thực tế hoặc kiểm thử các vai trò trên điện thoại.
