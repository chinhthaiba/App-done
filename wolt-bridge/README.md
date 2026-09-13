# Wolt ADB Bridge

Tool riêng để thử đọc đơn Wolt từ Galaxy Tab A9/Android qua ADB. Phần này chưa chạm vào app chính, Uber hoặc Lieferando.

## Cách chạy nhanh

1. Mở Wolt trên tablet và vào màn hình chi tiết đơn.
2. Cắm USB, bật `Gỡ lỗi USB`, trạng thái `adb devices` phải là `device`.
3. Chạy:

```bat
wolt-bridge\wolt-test.bat
```

Tool sẽ tạo:

```text
wolt-bridge\out\last-window.xml
wolt-bridge\out\last-order.json
```

## Lệnh thủ công

```powershell
node wolt-bridge\wolt-adb-reader.js devices
node wolt-bridge\wolt-adb-reader.js dump
node wolt-bridge\wolt-adb-reader.js screenshot
```

Nếu ADB không nằm ở `D:\platform-tools\adb.exe`, chạy:

```powershell
node wolt-bridge\wolt-adb-reader.js dump --adb "DUONG_DAN_DEN_ADB_EXE"
```

## Khi parser chưa đúng

Gửi 2 file này để chỉnh parser:

```text
wolt-bridge\out\last-window.xml
wolt-bridge\out\last-order.json
```

Mục tiêu sau khi ổn định:

- thêm nút `Lấy đơn Wolt`,
- hiện panel `Wolt → ThaiAsia`,
- gửi sang Admin giống Uber/Lieferando,
- sau đó mới tính auto phát hiện đơn mới.
