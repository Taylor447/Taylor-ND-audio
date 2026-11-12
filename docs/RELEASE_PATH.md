# Lộ trình phát hành Taylor APO

## Trạng thái hiện tại

Giai đoạn C trong repo là **prototype phòng lab**, không phải bộ cài APO dùng được trên mọi thiết bị. DLL có COM class factory, các interface APO cơ bản và một đường xử lý stereo float32; tuy nhiên chưa có INF/extension package cho một driver âm thanh cụ thể, chưa được ký, chưa chạy HLK và chưa được kiểm thử trong VM. Configurator chủ ý không ghi `FxProperties`, không thay APO của hãng và không bật `DisableProtectedAudioDG`.

Windows dùng mô hình componentized audio driver để đăng ký APO. Từ Windows 10 1809, APO được gắn như thành phần PnP của thiết bị; thiết kế hiện đại không cung cấp cách đăng ký một APO duy nhất toàn cục cho các driver khác nhau. Windows 11 cũng đưa ra CAPX / `IAudioSystemEffects3` và các kiểm tra HLK mới cho APO phân phối cùng driver. Vì vậy, để phát hành phải làm việc với từng OEM/IHV hoặc tạo package phù hợp cho đúng phần cứng/driver được hỗ trợ. Xem [Implementing Audio Processing Objects](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/implementing-audio-processing-objects), [Windows 11 APO APIs](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/windows-11-apis-for-audio-processing-objects) và [mẫu SYSVAD APO của Microsoft](https://github.com/microsoft/Windows-driver-samples/tree/main/audio/sysvad).

## Các chặng đề xuất

| Chặng | Công việc | Ước lượng lịch làm | Chi phí đã biết / ghi chú |
|---|---|---:|---|
| 0 · đóng prototype | Khóa ABI, thêm unit test/harness, rà lỗi callback, threat model shared memory và crash recovery | 1–3 tuần | Nội bộ; chưa bao gồm thiết bị/QA ngoài |
| 1 · một driver mục tiêu | Chọn một thiết bị/driver có quyền thử nghiệm; tạo INF extension/HSA đúng mô hình; xác nhận vị trí SFX/MFX/EFX, format, mode và restore | 3–8 tuần | Cần thiết bị thật và sự phối hợp của chủ driver; không thể suy ra chi phí từ tài liệu công khai |
| 2 · ký và thử nội bộ | Tạo tổ chức trong Hardware Developer Program, EV code signing, ký attestation để thử nghiệm phù hợp, kiểm tra cài/gỡ/rollback trên VM và máy thử | 2–6 tuần, có thể song song | Microsoft yêu cầu EV certificate để mở Hardware Dev Center submission; SSL.com hiện niêm yết EV từ **349 USD/năm**, giá có thể đổi và có thể phát sinh lưu trữ khóa/thuế/phí dịch vụ. Nguồn: [Partner Center for Windows Hardware](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/) và [SSL.com EV Code Signing pricing](https://www.ssl.com/products/software-integrity/code-signing/ev/). |
| 3 · chứng nhận | Chạy Windows HLK, sửa lỗi, nộp gói và HLK logs qua Partner Center để lấy chữ ký WHQL/certification | 1–3 tháng cho một cấu hình đầu tiên; dự phòng nhiều vòng sửa | Phí phòng lab, thiết bị, nhân lực và lịch cấp chứng nhận tùy đối tác. Microsoft yêu cầu bài test HLK cho đường Windows Hardware Compatibility Program; không có mức phí hoặc thời gian xử lý cố định được dùng trong ước lượng này. |
| 4 · mở rộng driver | Thêm ma trận endpoint, Windows build, x64/ARM64 và kiểm thử OEM/APO xung đột | 2–6 tháng trở lên | Mỗi họ driver/kiến trúc có thể cần package, chữ ký và xác nhận khác nhau; không nên quảng bá “mọi driver”. |

Các khoảng thời gian trên là **ước lượng kế hoạch của dự án**, không phải SLA của Microsoft hay nhà cung cấp chứng chỉ. Chi phí EV là giá hiển thị của một nhà cung cấp tại thời điểm viết, không phải báo giá. Tài liệu Microsoft không nêu phí đăng ký Hardware Developer Program nên tài liệu này không tự gán một con số.

## Attestation hay HLK/WHQL

- **Attestation signing** phù hợp cho một số vòng thử nghiệm/phân phối giới hạn. Nó cần tài khoản Hardware Dev Center và EV certificate, nhưng không biến package thành Windows Certified; Microsoft nêu rõ gói attestation không được đưa lên Windows Update cho khách hàng retail.
- **HLK/WHQL** là đích phát hành rộng hơn: chạy bộ test phù hợp, gửi kết quả HLK và package qua Partner Center, xử lý lỗi cho tới khi đạt. Tham khảo [Attestation sign Windows drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-attestation), [Driver signing offerings](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings) và [Partner Center flow](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/).
- EV là yêu cầu để tạo/đăng ký tài khoản submission driver; nó không tự chứng nhận APO và không thay cho test tương thích.

## So với phát hành tiếp giai đoạn A/B

| Lựa chọn | Phạm vi thực tế | Công việc/phụ thuộc | Khuyến nghị |
|---|---|---|---|
| A · Equalizer APO | Dùng APO/driver cài sẵn của Equalizer APO cho các endpoint người dùng chọn | Cần cài riêng Equalizer APO, quyền ghi cấu hình; không phải Taylor APO | Giữ làm đường thay thế, cung cấp hướng dẫn khôi phục |
| B · Taylor Engine | Định tuyến WASAPI shared qua VB-CABLE rồi phát tới endpoint thật | Cần cáp ảo, chọn thiết bị và quản lý độ trễ/xrun | Tiếp tục cải thiện telemetry, hot-plug và fallback |
| C · Taylor APO | Xử lý trong `audiodg.exe` khi driver package của endpoint đăng ký và Windows nạp APO | INF/extension theo thiết bị, ký/HLK, kiểm soát crash trong tiến trình audio | Chỉ phát hành cùng OEM/IHV hoặc driver package cụ thể sau kiểm thử. Không thay A/B cho tới khi có một ma trận hỗ trợ đã chứng minh. |

## Cổng chấp nhận trước khi công bố

1. Chốt ABI C, layout shared memory và phiên bản giao thức; thêm kiểm thử tương thích 32/64-bit nếu sau này cần bridge khác kiến trúc.
2. Có gói INF thật cho ít nhất một thiết bị mục tiêu và quy trình gỡ/restore được xác minh từ snapshot sạch.
3. Xác minh `APOProcess` không cấp phát, khóa, log/I/O, không tính hệ số/FFT nặng trên callback; chuyển công việc chuẩn bị hệ số và IR sang luồng nền.
4. Xác minh cờ silent/valid, bypass, latency, stereo và passthrough nhiều kênh; chạy test định dạng và stress trên Windows 10/11 mục tiêu.
5. Hoàn thành kiểm tra crash/fail-open, Application Verifier và thời lượng dài; telemetry phải phân biệt “không có stream” với “APO không được nạp”.
6. Tích hợp CAPX/`IAudioSystemEffects3` cho gói Windows 11 nếu cần; có HLK logs và ký đúng tuyến phát hành.
7. Chỉ bật lựa chọn cài đặt khi đã có package đã ký. Không dùng `DisableProtectedAudioDG=1` như giải pháp phát hành.
