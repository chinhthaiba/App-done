# ThaiAsia Auto Update cho Windows 7

Hệ thống này không dùng Cloudflare hay server riêng. App kiểm tra một repository GitHub private, tải bản phát hành đã ký, chờ không xử lý đơn liên tục 2 phút rồi tự cập nhật và khởi động lại.

## 1. Việc chỉ làm một lần

### Tạo repository phát hành

1. Đăng nhập GitHub bằng tài khoản `x247hl`.
2. Chọn **New repository**.
3. Đặt tên `chinhthaiba-thaiasia-releases`.
4. Chọn **Private**.
5. Chọn **Add a README file** và tạo repository.

Repository này chỉ dùng để chứa Release. Không đưa khóa riêng trong `.release-secrets` lên GitHub.

### Sao lưu khóa ký

Sao lưu file sau vào USB hoặc nơi riêng tư:

`D:\App Done\.release-secrets\update-private-key.pem`

Nếu mất khóa này, các máy đã cài app sẽ không chấp nhận bản cập nhật được ký bằng khóa mới. Không gửi khóa qua email, chat hoặc GitHub.

### Tạo token cho máy Windows 7

1. Trên GitHub mở **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Chọn **Generate new token**.
3. Đặt tên, ví dụ `ThaiAsia Win7 Updater`.
4. Chọn thời hạn đủ dài và đặt lịch nhắc trước ngày hết hạn.
5. Trong **Repository access**, chọn **Only select repositories** và chỉ chọn `chinhthaiba-thaiasia-releases`.
6. Trong **Repository permissions**, đặt **Contents: Read and write**. Remote Control cần quyền ghi để tạo `ack`, `done` và đồng bộ báo cáo. Không cấp quyền Actions hoặc Administration.
7. Tạo token và chép token một lần.

Không gửi token vào cuộc trò chuyện. Token được nhập trực tiếp trên máy Windows 7 và được Windows DPAPI mã hóa.

## 2. Cài bản nền 1.1.0 lên Windows 7

Bản 1.1.0 là bản đầu tiên có updater, vì vậy cần chép thủ công toàn bộ thư mục app sang máy Windows 7 đúng một lần.

1. Dừng app và watchdog cũ trên máy Windows 7.
2. Sao lưu thư mục app cũ; không xóa ngay.
3. Chép thư mục dự án/bản build mới sang máy đó.
4. Chạy `create-watchdog-shortcuts.bat` nếu cần tạo lại shortcut.
5. Mở app qua shortcut **ThaiAsia AllInOne**.
6. Trong menu chọn **Auto Update → Cấu hình GitHub…**.
7. Repository phải là `chinhthaiba/chinhthaiba-thaiasia-releases`.
8. Dán fine-grained token có quyền **Contents: Read and write**, bật tự cài và bấm **Lưu cấu hình**.
9. Bấm **Kiểm tra cập nhật ngay** để xác nhận kết nối.

## 3. Tạo một bản cập nhật mới

Sau khi sửa và kiểm tra tính năng, chạy file `prepare-update.bat` rồi nhập version mới. File này sẽ tự tạo gói, kiểm tra, upload đủ ba asset và phát hành bản stable lên GitHub.

Lệnh dưới đây chỉ tạo gói local, không tự phát hành:

```bat
npm.cmd run update:prepare -- 1.1.1
```

Mỗi lần phải dùng version lớn hơn bản trước. Kết quả nằm trong:

```text
D:\App Done\release-output\v1.1.1\
  thaiasia-app-v1.1.1.bundle.json.gz
  thaiasia-update-manifest.json
  thaiasia-update-manifest.sig
```

Không chỉnh sửa ba file sau khi chúng đã được ký.

## 4. Đưa bản cập nhật lên GitHub

`prepare-update.bat` thực hiện tự động theo thứ tự an toàn:

1. Tạo GitHub Release ở trạng thái **Draft**.
2. Upload đúng ba asset đã ký.
3. Đọc lại và kiểm tra tên, trạng thái và kích thước của cả ba asset.
4. Chỉ khi mọi kiểm tra đều đúng mới chuyển Release thành stable/public và đặt làm bản mới nhất.

Nếu upload lỗi giữa chừng, Release vẫn là Draft nên app tại nhà hàng không tải nhầm. Sau khi sửa kết nối hoặc token, chạy lại cùng version bằng lệnh:

```bat
npm.cmd run update:publish -- 1.1.1
```

Script ưu tiên token trong biến môi trường `GITHUB_TOKEN`, sau đó tới `.release-secrets\github-release-token.txt`, rồi mới dùng token đang ghi trong tài liệu này. Không truyền token trực tiếp trên dòng lệnh.

Máy Windows 7 sẽ thấy release trong tối đa khoảng 10 phút. Draft và Pre-release luôn bị bỏ qua.

## 5. Cơ chế an toàn

- Chỉ tải từ repository đã cấu hình.
- Manifest phải có chữ ký Ed25519 hợp lệ.
- Bundle phải đúng kích thước và SHA-256.
- Mỗi file bên trong được kiểm tra SHA-256.
- Đường dẫn nguy hiểm như `..` hoặc đường dẫn tuyệt đối bị từ chối.
- App chỉ cài sau khi các trang xử lý đơn báo rảnh liên tục 2 phút.
- Watchdog tạm dừng khi có `update.lock`.
- Bản cũ được giữ tại `dist\ThaiAsiaApp-win32-x64\resources\app.rollback`.
- Nếu bản mới không tạo heartbeat đúng version trong 120 giây, helper tự phục hồi bản cũ.

## 6. Xem trạng thái và log

Trên máy Windows 7:

```text
%APPDATA%\ThaiAsiaAllinOne\updates\auto-update-status.json
%APPDATA%\ThaiAsiaAllinOne\updates\auto-update.log
```

Không đăng các file cấu hình/token trong `%APPDATA%` lên GitHub.

## 7. Khi token hết hạn

Tạo token fine-grained mới với đúng quyền **Contents: Read and write**, sau đó mở **Auto Update → Cấu hình GitHub…**, dán token mới và lưu. Không cần cài lại app.

Token mặc định đã nằm trong app. Nếu token bị thu hồi hoặc hết hạn, tạo token mới và cập nhật trong app/code phát hành.
