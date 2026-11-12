# Taylor APO prototype: phạm vi và ABI

## Các tiến trình

- `audiodg.exe` nạp `taylor-apo.dll` nếu driver package đã khai báo APO cho endpoint. APO chỉ xử lý stereo float32 44,1–192 kHz trong prototype; silent được lan truyền, nhiều kênh/định dạng khác đi thẳng. Mỗi sample rate format mới tạo lại DSP trong `LockForProcess`.
- `dsp-core` tái dùng trực tiếp các module DSP của `engine/src/dsp` thông qua ABI C. C API không truyền `String` qua biên C. `set_profile` đã bỏ tạo `Vec` tạm; tuy vậy tính hệ số hiện vẫn diễn ra lúc APO nhận profile mới và FFT telemetry nằm trên audio path. Đây là điểm chặn phát hành cần chuyển sang chuẩn bị nền trước khi công bố.
- `tnd-bridge.exe` giữ giao thức WebSocket JSON hiện có trên `127.0.0.1` với token theo lần chạy. Bridge tạo `Local\\TaylorNDAudio-APO-v1`, đọc telemetry seqlock và ghi profile. Đó là kênh điều khiển cục bộ, không phải kênh audio.
- `taylor-configurator.exe --guided` chỉ liệt kê endpoint và giải thích giới hạn. `--register-com` / `--unregister-com` chỉ thao tác đăng ký COM prototype khi có cờ lab và chuỗi xác nhận; thao tác này **không gắn APO vào endpoint**.
- `tnd-recover.exe` chỉ nhập file `.reg` đã được đặt trong thư mục backup của ProgramData. Do configurator không sửa endpoint registry, prototype hiện không sinh backup đó.

## Layout shared memory version 1

`dsp-core/src/lib.rs::SharedBlock` và `apo/include/tnd_shared.h::TndSharedBlock` phải khớp trường, căn chỉnh và kích thước:

1. `magic`, `version`.
2. `profileSequence`: số lẻ khi bridge đang ghi `TndParams`, số chẵn khi dữ liệu ổn định.
3. Một `TndParams` cố định, 10 dải EQ cùng bass/treble/dialogue/width/balance/crossfeed/master/compressor/bypass.
4. Bộ đếm cấp slot và 8 cặp sequence/`TndTelemetry`; mỗi APO giữ một slot.

Không thêm con trỏ, `String`, `Vec`, `bool` Rust hay kiểu phụ thuộc compiler vào struct shared. Khi đổi ABI hãy tăng `version`, kiểm tra kích thước trên x64 và tạo mapping version mới.

## Phạm vi DSP đang dùng

Đường APO hiện dùng EQ RBJ 10 băng, bass/treble shelf, dialogue, matrix width, balance/crossfeed, compressor nội bộ, limiter lookahead và telemetry. Convolution/IR không khả dụng trong APO prototype; bridge trả lỗi cho profile yêu cầu IR. Một `APOProcess` block lớn được chia đoạn 512 frame để khớp vùng DSP đã cấp phát. Nếu ABI báo lỗi, đoạn hiện tại được khôi phục từ buffer dự phòng; nếu format không hỗ trợ thì output passthrough.

Latency báo bằng số sample của limiter 1,5 ms tại sample rate hiện tại; không tính latency driver, endpoint, Bluetooth, app hay plugin khác. `xruns=0` từ bridge chưa phải bộ đếm xrun thật của audio engine.

## Vì sao chưa có installer triển khai endpoint

COM class registration chỉ giúp COM tìm DLL; nó không thêm APO vào SFX/MFX/EFX endpoint graph. Package driver INF/extension và cấu hình endpoint phù hợp vẫn cần thiết. Ghi trực tiếp một CLSID vào `FxProperties` hoặc tắt Protected AudioDG không thay thế quy trình đó, và có thể làm mất hiệu ứng hãng/âm thanh. Hãy xem [tài liệu APO Microsoft](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/implementing-audio-processing-objects) và [mẫu Windows Driver Samples](https://github.com/microsoft/Windows-driver-samples/tree/main/audio/sysvad).
