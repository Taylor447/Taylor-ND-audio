# Thử Taylor APO trong máy ảo

## Yêu cầu

- Máy Windows 10/11 x64 dùng làm host, Hyper-V hoặc VMware và đủ dung lượng cho snapshot.
- VM Windows x64 sạch có checkpoint/snapshot trước mọi bước thay đổi; cài Visual Studio Build Tools C++/CMake, Windows SDK, WDK và Rust stable MSVC target.
- Bật checkpoint tự động hoặc tạo checkpoint thủ công có tên `before-taylor-apo`. Không chạy `DisableProtectedAudioDG`, không chép DLL vào `audiodg.exe`, không sửa FxProperties trên máy chính.
- VM thường không có đường âm thanh giống máy vật lý. Có thể dùng endpoint audio ảo trong VM để thử cơ chế COM/harness; không lấy kết quả VM làm tuyên bố driver tương thích.

## Build và kiểm tra offline

Từ PowerShell tại repo:

```powershell
npm install
cargo test --manifest-path dsp-core/Cargo.toml
cargo test --manifest-path engine/Cargo.toml
.
scripts\build-stage-c.ps1
```

Harness COM chỉ nạp DLL trong tiến trình harness, không nạp vào `audiodg.exe`:

```powershell
.
stage-c\tools\taylor-apo-harness.exe .\stage-c\apo\taylor-apo.dll
```

Harness thử 44,1/48/96 kHz stereo, buffer silent và 6 kênh passthrough. Unit test Rust thử bypass từng mẫu sau khi hết chuyển tiếp, giới hạn frame và bố cục kênh. Chúng chưa thay thế kiểm thử driver/HLK và chưa chứng minh callback real-time đạt giới hạn CPU.

## Kiểm tra bridge và giao diện

1. Khởi chạy `npm start` trong VM sau khi `build-stage-c.ps1` hoàn tất.
2. Đóng app/bridge khác đang dùng mapping Taylor, rồi chạy harness offline trước. Harness tạo shared mapping tên cố định trong session hiện tại; không chạy cùng lúc với Taylor APO bridge.
3. Vào **Cài đặt → Chế độ xử lý → Taylor APO · thử nghiệm**.
4. Bridge mở loopback trên `127.0.0.1`, sinh token dùng một lần và tạo shared mapping ACL cho SYSTEM, Local Service, Administrators và Users. Xác nhận firewall không hỏi kết nối mạng ngoài; bridge không bind địa chỉ LAN.
5. Khi chưa có APO được gắn bằng package, trạng thái phải là **Chưa thấy audio callback**. Đây là trạng thái đúng; không xem bridge “connected” là bằng chứng APO đã chạy.
6. Mở **Mở hướng dẫn APO**, đọc danh sách endpoint. Configurator hiện chỉ liệt kê, không chỉnh FxProperties hoặc cài endpoint.
7. Gửi preset EQ và xác nhận bridge trả acknowledgement. Khi chọn reverb/IR, bridge phải báo chưa hỗ trợ, không được thông báo áp dụng thành công.
8. Mở tab Phân tích: nếu không có APO callback, telemetry phải trống/không có heartbeat. Không lấy telemetry loopback của Electron làm telemetry APO.

## Kiểm thử nạp APO với INF

Hiện repo **không cung cấp INF/extension package để gắn APO vào endpoint**, do cách đó cần xác định driver/thiết bị mục tiêu. Khi đã có package riêng được ký thử nghiệm và cho đúng endpoint:

1. Tạo snapshot mới của VM trước khi cài package.
2. Export/backup khóa và quyền truy cập endpoint theo đúng INF package; xác nhận đã có đường rollback độc lập.
3. Cài package trong VM bằng quy trình do chủ driver/Windows Hardware Lab Kit quy định. Không tạo giá trị `FxProperties` thủ công dựa trên hướng dẫn chung.
4. Khởi động lại audio graph theo tài liệu package; mở app, bật Taylor APO rồi phát âm thanh test ở mức thấp.
5. Xác minh heartbeat, peak/RMS/spectrum, trạng thái format và latency. Tắt stream rồi xác nhận UI không nhầm “im lặng” với “đã nạp APO”.
6. Thử chuyển format 44.1/48/96 kHz, thiết bị, sleep/resume và rút/cắm endpoint. Nhiều kênh phải đi passthrough.
7. Chạy Application Verifier trên VM phù hợp, chạy stress ngắn trước rồi dài; xem xrun/ETW và crash logs. Không dùng harness DLL trực tiếp làm kiểm thử Application Verifier cho `audiodg.exe`.
8. Gỡ package theo đúng uninstall INF, xác nhận endpoint trở lại trạng thái trước, khởi động lại VM và phát tiếng bình thường.
9. Nếu mất tiếng, rollback snapshot trước. `tnd-recover.exe` chỉ nhập file `.reg` backup trong `%ProgramData%\TaylorNDAudio\backup`; build prototype hiện chưa tạo backup endpoint vì chưa sửa endpoint registry.

### Khởi động Safe Mode để rollback package lab

Nếu một package thử nghiệm riêng làm audio engine không khởi động, ưu tiên hoàn tác Hyper-V/VMware snapshot. Nếu cần phục hồi trong guest: mở **Windows Recovery Environment → Troubleshoot → Advanced options → Startup Settings → Restart → Safe Mode**; đăng nhập tài khoản Administrator, rồi chạy `tnd-recover.exe --restore "C:\ProgramData\TaylorNDAudio\backup\<backup>.reg"` từ Command Prompt elevated. Không đoán tên backup: chỉ nhập file đã tạo trước khi cài. Safe Mode có thể không khởi động dịch vụ audio; sau khi import, reboot vào chế độ thường và xác nhận âm thanh. Prototype trong repo chưa tạo backup endpoint hay package INF, nên không có `.reg` endpoint để nhập cho bản build hiện tại.

## Khi VM không phát được audio

Một số hypervisor không đưa endpoint render thật vào guest. Điều đó không cản trở offline harness và kiểm tra IPC, nhưng không thể xác minh APO được audio engine nạp. Ghi kết quả là **không có endpoint test**, không ghi “pass”. Kiểm tra stream thật phải chạy trên máy lab có thiết bị và package được phép thử, vẫn giữ snapshot/ảnh hệ thống để phục hồi.
