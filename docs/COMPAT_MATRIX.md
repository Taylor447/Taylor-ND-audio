# Ma trận tương thích Taylor ND Audio

Ma trận này là kế hoạch chạy thử, không phải chứng nhận. Không suy diễn kết quả từ model driver khác; điền từng ô chỉ sau khi chạy máy thật/VM, xác nhận có âm thanh và ghi độ trễ đo được cùng xrun.

| Windows | Kiến trúc | Driver / endpoint | APO | Taylor Engine | Độ trễ đo | Xrun / ghi chú |
|---|---|---|---|---|---|---|
| Windows 10 22H2 | x64 | Realtek inbox + Dolby/Waves/Nahimic | Chưa thử | Chưa thử | — | — |
| Windows 10 22H2 | ARM64 | Realtek/OEM | Chưa thử | Chưa thử | — | — |
| Windows 11 23H2 | x64 | Realtek OEM | Chưa thử | Chưa thử | — | — |
| Windows 11 23H2 | ARM64 | OEM audio | Chưa thử | Chưa thử | — | — |
| Windows 11 24H2 | x64 | Intel SST / Conexant / Cirrus | Chưa thử | Chưa thử | — | — |
| Windows 11 24H2 | ARM64 | Qualcomm/OEM audio | Chưa thử | Chưa thử | — | — |
| Windows 11 hiện tại | x64 / ARM64 | USB Audio Class 1/2 inbox | Chưa thử | Chưa thử | — | — |
| Windows 11 hiện tại | x64 / ARM64 | USB DAC OEM | Chưa thử | Chưa thử | — | — |
| Windows 11 hiện tại | x64 / ARM64 | Bluetooth A2DP / LE Audio | Chưa thử | Chưa thử | — | — |
| Windows 11 hiện tại | x64 / ARM64 | HDMI / DisplayPort | Chưa thử | Chưa thử | — | — |
| Windows 11 hiện tại | x64 | VB-CABLE / Voicemeeter | Chưa thử | Chưa thử | — | — |

## Quy trình

1. Chạy `cargo build --release --manifest-path engine/Cargo.toml --bins`.
2. Chạy `powershell -ExecutionPolicy Bypass -File scripts/compat-test.ps1` để lưu probe JSON/Markdown cục bộ. Báo cáo không tự gửi đi.
3. Dò từng endpoint, kiểm tra tên loại/bus và trạng thái trường chưa xác định. Không xem giá trị `null` như “không có driver/APO”.
4. Thử APO và Taylor Engine thủ công ở âm lượng thấp; xác nhận tuyến âm thanh, phát liên tục ít nhất 30 phút và ghi số xrun.
5. Đo độ trễ loopback ngoài ứng dụng hoặc bằng thiết bị đo; `latencyMs` nội bộ của Taylor Engine hiện chỉ là ước tính.
6. Ghi Windows build, kiến trúc, driver/version, backend, lỗi và cách khắc phục vào bảng; chỉ sửa file sau khi thử xong.

VM không có audio endpoint ảo chỉ kiểm tra được việc probe chạy và tạo báo cáo. Nó không chứng minh được driver/APO hoặc tiếng thực tế.
