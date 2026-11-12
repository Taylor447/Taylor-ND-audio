# Taylor ND Audio

Taylor ND Audio là ứng dụng desktop Windows 10/11 có giao diện tiếng Việt. Giai đoạn B bổ sung engine Rust riêng chạy DSP thời gian thực; Equalizer APO vẫn là chế độ xử lý thay thế. Giao diện Electron tiếp tục gọi hợp đồng chung `applyProfile(profile)` qua adapter nên preset và màn hình không phụ thuộc cú pháp engine.

## Cây thư mục

```text
taylor-nd-audio/
├─ assets/                         Logo SVG, lockup và icon ICO
├─ scripts/                        Tạo lại icon Windows
├─ engine/
│  ├─ Cargo.toml                    Các crate Rust được ghim phiên bản
│  ├─ benches/dsp_blocks.rs         Criterion benchmark 128/256/512 frame
│  └─ src/
│     ├─ main.rs                    Sidecar WebSocket, giao thức, khôi phục thiết bị
│     ├─ audio.rs                   Backend CPAL/WASAPI, ring buffer và hot-plug
│     ├─ protocol.rs                Kiểu thông điệp JSON
│     ├─ lib.rs                     Hợp đồng backend thay thế được
│     └─ dsp/
│        ├─ mod.rs                  Profile, chuỗi DSP, FFT telemetry và unit test
│        ├─ biquad.rs               RBJ biquad TDF-II, hệ số f64
│        ├─ convolution.rs          IR WAV và convolution FFT chia khối
│        ├─ drift.rs                Bộ điều khiển PI bù lệch đồng hồ
│        └─ limiter.rs              Lookahead limiter và trần an toàn
├─ src/
│  ├─ dsp/
│  │  ├─ engine.js                  Facade DSP dùng chung
│  │  ├─ engine-adapter.js          Chọn adapter APO hoặc Taylor
│  │  ├─ equalizer-apo.js           Adapter Equalizer APO giai đoạn A
│  │  └─ taylor-engine.js           Khởi chạy sidecar và giao tiếp WebSocket
│  ├─ renderer/                     Giao diện HTML/CSS/JS và biểu đồ
│  ├─ main.js                       Cửa sổ, tray, thiết bị, IPC, tự khởi động
│  └─ preload.js                    Cầu nối IPC có giới hạn
├─ package.json
└─ README.md
```

## Chạy ứng dụng từ source

Cài Node.js LTS, Rust stable 1.85 trở lên và công cụ build MSVC của Visual Studio. Mở PowerShell tại thư mục dự án rồi chạy:

```powershell
npm install
npm start
```

`npm start` chạy bước `prestart` để build sidecar Rust ở chế độ release trước khi mở Electron. Để build riêng engine:

```powershell
cargo build --release --manifest-path engine/Cargo.toml
```

Để tạo installer NSIS x64:

```powershell
npm run dist
```

Lệnh này build `engine/target/release/tnd-engine.exe`, rồi electron-builder chép binary vào `resources/engine/tnd-engine.exe` bằng cấu hình `extraResources`. Installer được tạo tại `dist/Taylor-ND-Audio-Setup-1.0.0.exe` và dùng `assets/taylor-nd-audio.ico` cho app, installer, shortcut và uninstaller. Installer không kèm VB-CABLE.

## Cài và chạy Taylor Engine

1. Trong Cài đặt, đổi **Engine DSP** sang **Taylor Engine**.
2. Nếu chưa có VB-CABLE, tải driver từ [trang chính thức VB-Audio](https://vb-audio.com/Cable/), cài bằng quyền Administrator và khởi động lại Windows. VB-CABLE là donationware của VB-Audio; người dùng tự tải và cài. Ứng dụng không đóng gói driver.
3. Trong Windows **Settings → System → Sound**, đặt **CABLE Input** làm thiết bị phát mặc định để âm thanh ứng dụng đi vào cáp ảo.
4. Trong Taylor ND Audio, chọn **CABLE Output** làm đầu vào ghi âm và chọn loa hoặc tai nghe vật lý làm đầu ra. Engine chặn CABLE Input ở đầu ra để tránh vòng lặp. Không có API ẩn nào được dùng để đổi thiết bị mặc định.
5. Chọn buffer 5, 10 hoặc 20 ms rồi bấm **Bắt đầu engine**. Phát âm thanh trong Windows; mục Phân tích sẽ lấy spectrum, waveform, peak và RMS từ chính engine.
6. Nút **Mở cài đặt âm thanh** mở trang Sound của Windows. Bấm **Kiểm tra lại cáp** sau khi cài hoặc rút/cắm lại thiết bị.

## Engine và chuỗi tín hiệu

Ứng dụng Windows → thiết bị phát mặc định CABLE Input → đầu ghi CABLE Output → Taylor Engine → loa/tai nghe do người dùng chọn.

Engine MVP dùng CPAL trên backend WASAPI shared-mode. Cấu trúc `AudioBackend` / `AudioSessionControl` tách backend khỏi giao thức và DSP để sau này thay bằng IAudioClient3. Hiện tại chưa gọi trực tiếp IAudioClient3 hoặc đặt chu kỳ thiết bị bằng API riêng; buffer 5/10/20 ms là yêu cầu gửi cho backend và có thể bị driver giới hạn. Độ trễ hiển thị là ước tính từ buffer, FIFO và khối DSP, không phải phép đo vòng lặp phần cứng. Mục tiêu dưới 30 ms và CPU dưới 3% cần đo trên từng máy/driver; dự án chưa tuyên bố đã đạt các con số đó.

Callback WASAPI chỉ đổi định dạng mẫu, downmix/đưa stereo frame vào ring buffer khóa-free hoặc lấy frame ra; không cấp phát heap, khóa mutex, ghi file hay log. DSP worker chạy ưu tiên MMCSS “Pro Audio”, resample bất đồng bộ bằng rubato và dùng PI feedback theo FIFO để bù hai đồng hồ. Ring buffer truyền frame stereo nguyên tử để tránh lệch kênh khi đầy. Thiết bị nhiều kênh được downmix xuống stereo và giao diện hiện cảnh báo. Thiết bị 44.1/48/96 kHz cùng mẫu i16/i24/f32 được hỗ trợ qua chuyển đổi CPAL; engine cũng nhận định dạng CPAL khác khi thiết bị cung cấp.

Chuỗi xử lý gồm preamp tự động, 10 peaking EQ RBJ TDF-II, bass/treble shelf, dialogue, mở rộng mid/side và crossfeed, IR convolution, compressor tích hợp, limiter lookahead 1.5 ms, master gain và trần cứng −1 dBFS. Tham số filter, gain, crossfeed và compressor được làm mượt khoảng 20 ms; khởi động có fade-in khoảng 200 ms. Bypass crossfade bỏ qua đường DSP và giữ bit mẫu cho tín hiệu dưới trần an toàn; các mẫu vượt −1 dBFS vẫn bị giới hạn để bảo vệ thiết bị.

IR cần là WAV có cùng sample rate với đầu ra đang chạy, tối đa 5 giây. Engine hiện phân vùng IR bằng FFT và downmix IR nhiều kênh về stereo. Equalizer APO dùng VST2 nếu người dùng tự chọn plugin; Taylor Engine dùng compressor nội bộ nên không cần DLL VST. Limiter an toàn cuối chuỗi luôn bật ở cả hai chế độ.

Sidecar mở cổng ngẫu nhiên chỉ trên `127.0.0.1`; Electron nhận token từ stdout riêng của tiến trình rồi xác thực WebSocket. IPC gồm `listDevices`, `start`, `stop`, `setProfile`, `setBypass`, `loadImpulse`; engine gửi trạng thái, telemetry khoảng 33 ms, lỗi thiết bị và số xrun. Core Audio `IMMNotificationClient` đánh dấu danh sách thiết bị cần quét lại; khi stream mất thiết bị, engine tắt tiếng và thử kết nối lại tối đa ba lần. Electron giám sát tiến trình sidecar và cũng thử khởi động lại tối đa ba lần sau khi crash.

## Kiểm thử và benchmark

```powershell
cargo test --manifest-path engine/Cargo.toml
cargo bench --manifest-path engine/Cargo.toml
```

Unit test bao gồm parse profile preset hiện có, đáp ứng filter tại tần số trung tâm, đáp ứng xung/bước, bypass bit-perfect dưới trần, bỏ qua IR khi bypass, limiter không vượt −1 dBFS và PI giữ FIFO khi mô phỏng lệch clock 100 ppm trong 30 phút. Criterion benchmark đo khối 128/256/512 frame. Chạy benchmark trên máy mục tiêu để đánh giá CPU; không dùng kết quả từ máy khác làm cam kết.

### Kiểm tra bằng tai và giao diện

1. Chọn Taylor Engine và xác nhận đầu vào là CABLE Output, đầu ra là thiết bị vật lý.
2. Mở **Kiểm tra**, phát tone hoặc nhiễu hồng mức vừa phải; tăng/giảm EQ và xác nhận âm thanh đổi ngay.
3. Mở **Phân tích**, kiểm tra phổ, waveform, peak/RMS đổi theo tín hiệu.
4. Thử tone quét 20 Hz–20 kHz ở âm lượng thấp để kiểm tra các băng tần và phát hiện clipping.
5. Chạy liên tục ít nhất 30 phút; theo dõi xrun và tiếng lách tách. Tăng buffer lên 10 hoặc 20 ms nếu driver không ổn định ở 5 ms.
6. Rút/cắm lại tai nghe khi engine chạy; xác nhận trạng thái thiết bị, thông báo và kết nối lại.
7. Thử Bypass A/B, tắt/bật convolution, chuyển giữa Taylor Engine và Equalizer APO.

## Chế độ Equalizer APO

Chọn **Equalizer APO** trong Cài đặt. Lần đầu ứng dụng sao lưu `config.txt` thành `config.txt.taylor-nd-audio.bak` và nối đúng một dòng `Include: taylor-nd-audio.txt` nếu chưa có. Thay đổi profile sau đó chỉ ghi file cấu hình riêng `taylor-nd-audio.txt`. Nếu Windows chặn quyền ghi, dùng nút **Khởi động lại với quyền Administrator**. Equalizer APO chỉ xử lý thiết bị đã tích chọn trong Configurator.

Hướng dẫn cài: tải [Equalizer APO](https://sourceforge.net/projects/equalizerapo/), chạy Configurator, tích loa/tai nghe cần xử lý, áp dụng và khởi động lại nếu được yêu cầu. Tắt **Audio enhancements** của Realtek/Dolby trên cùng thiết bị để tránh áp hiệu ứng hai lần.

## Thay backend bằng IAudioClient3 sau này

Tạo một kiểu backend mới thực hiện `AudioBackend` và một kiểu phiên thực hiện `AudioSessionControl` trong `engine/src/audio.rs`; giữ giao thức JSON/WebSocket và module `dsp` nguyên trạng. Backend mới chịu trách nhiệm enumerate thiết bị, mở shared-mode stream với period mà IAudioClient3 cho phép, chuyển frame stereo qua ring buffer và phát hot-plug notification. Thay `WasapiCpalBackend` trong `engine/src/main.rs` sau khi backend mới qua cùng kiểm thử audio và đo latency/xrun trên Windows.

## Nguồn tham khảo

- [CPAL 0.18.2 — tài liệu và thay đổi API](https://docs.rs/cpal/0.18.2/cpal/)
- [rubato 0.15.0 — xử lý resample thời gian thực](https://docs.rs/rubato/0.15.0/rubato/)
- [Windows — AvSetMmThreadCharacteristicsW](https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmthreadcharacteristicsw)
- [Windows Core Audio — IMMNotificationClient](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nn-mmdeviceapi-immnotificationclient)
- [VB-CABLE và điều kiện giấy phép](https://vb-audio.com/Cable/) · [VB-Audio licensing](https://vb-audio.com/Services/licensing.htm)
