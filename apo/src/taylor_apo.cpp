// APO thử nghiệm Taylor ND Audio: callback chỉ thao tác trên vùng nhớ có sẵn.
#include <Windows.h>
#include <mmreg.h>
#include <ksmedia.h>
#include <audioenginebaseapo.h>
#include <audioapotypes.h>
#include <atomic>
#include <array>
#include <cstring>
#include <new>
#include "tnd_dsp.h"
#include "tnd_shared.h"

extern "C" IMAGE_DOS_HEADER __ImageBase;

namespace {
// CLSID riêng của prototype; khi phát hành phải cấp GUID chính thức và cài qua INF.
const CLSID CLSID_TaylorAudioApo = { 0x8c2d5171, 0x9d77, 0x4f62, { 0x9b, 0x5d, 0x43, 0xa1, 0x6f, 0x8e, 0x31, 0x20 } };
volatile LONG g_objects = 0;
volatile LONG g_serverLocks = 0;

bool IsFloatFormat(const WAVEFORMATEX* format) noexcept {
    if (!format || format->wBitsPerSample != 32) return false;
    if (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
    if (format->wFormatTag != WAVE_FORMAT_EXTENSIBLE || format->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)) return false;
    return IsEqualGUID(reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format)->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) != FALSE;
}

class TaylorApo final : public IAudioProcessingObject,
                        public IAudioProcessingObjectRT,
                        public IAudioProcessingObjectConfiguration,
                        public IAudioSystemEffects2 {
public:
    TaylorApo() noexcept { InterlockedIncrement(&g_objects); }
    ~TaylorApo() {
        if (m_dsp) tnd_destroy(m_dsp);
        if (m_view) UnmapViewOfFile(m_view);
        if (m_mapping) CloseHandle(m_mapping);
        InterlockedDecrement(&g_objects);
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) noexcept override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (IsEqualIID(iid, __uuidof(IUnknown)) || IsEqualIID(iid, __uuidof(IAudioProcessingObject))) *out = static_cast<IAudioProcessingObject*>(this);
        else if (IsEqualIID(iid, __uuidof(IAudioProcessingObjectRT))) *out = static_cast<IAudioProcessingObjectRT*>(this);
        else if (IsEqualIID(iid, __uuidof(IAudioProcessingObjectConfiguration))) *out = static_cast<IAudioProcessingObjectConfiguration*>(this);
        else if (IsEqualIID(iid, __uuidof(IAudioSystemEffects)) || IsEqualIID(iid, __uuidof(IAudioSystemEffects2))) *out = static_cast<IAudioSystemEffects2*>(this);
        else return E_NOINTERFACE;
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() noexcept override { return static_cast<ULONG>(InterlockedIncrement(&m_refs)); }
    ULONG STDMETHODCALLTYPE Release() noexcept override {
        const LONG refs = InterlockedDecrement(&m_refs);
        if (refs == 0) delete this;
        return static_cast<ULONG>(refs);
    }

    // IAudioSystemEffects: giữ khởi tạo tối giản, không dựa vào tham số ngoài.
    HRESULT STDMETHODCALLTYPE Initialize(UINT32, BYTE*) noexcept override {
        m_mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, L"Local\\TaylorNDAudio-APO-v1");
        if (m_mapping) {
            m_view = static_cast<TndSharedBlock*>(MapViewOfFile(m_mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(TndSharedBlock)));
            if (m_view && (m_view->magic != TND_SHARED_MAGIC || m_view->version != TND_SHARED_VERSION)) {
                UnmapViewOfFile(m_view); m_view = nullptr;
                CloseHandle(m_mapping); m_mapping = nullptr;
            }
        }
        if (m_view) m_slot = static_cast<LONG>(InterlockedIncrement(&m_view->nextTelemetrySlot) % TND_TELEMETRY_SLOTS);
        return S_OK; // Nếu bridge chưa chạy, audio đi thẳng.
    }

    HRESULT STDMETHODCALLTYPE GetEffectsList(LPGUID* ids, UINT* count, HANDLE) noexcept override {
        if (!ids || !count) return E_POINTER;
        *ids = nullptr; *count = 0; // Chưa quảng bá effect discovery vì đây mới là build thử nghiệm.
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE Reset() noexcept override { return S_OK; }
    HRESULT STDMETHODCALLTYPE GetLatency(HNSTIME* latency) noexcept override {
        if (!latency) return E_POINTER;
        *latency = m_latency;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetRegistrationProperties(APO_REG_PROPERTIES** properties) noexcept override {
        if (!properties) return E_POINTER;
        *properties = nullptr;
        const size_t bytes = sizeof(APO_REG_PROPERTIES) + sizeof(IID);
        auto* result = static_cast<APO_REG_PROPERTIES*>(CoTaskMemAlloc(bytes));
        if (!result) return E_OUTOFMEMORY;
        ZeroMemory(result, bytes);
        result->clsid = CLSID_TaylorAudioApo;
        result->Flags = static_cast<APO_FLAG>(APO_FLAG_INPLACE | APO_FLAG_SAMPLESPERFRAME_MUST_MATCH | APO_FLAG_BITSPERSAMPLE_MUST_MATCH | APO_FLAG_FRAMESPERSECOND_MUST_MATCH);
        result->u32NumAPOInterfaces = 1;
        result->iidAPOInterfaceList[0] = __uuidof(IAudioSystemEffects2);
        result->szFriendlyName[0] = L'\0';
        wcscpy_s(result->szFriendlyName, L"Taylor ND Audio APO (Lab)");
        wcscpy_s(result->szCopyrightInfo, L"Taylor ND Audio - prototype");
        result->u32MajorVersion = 0; result->u32MinorVersion = 1;
        result->u32MinInputConnections = 1; result->u32MaxInputConnections = 1;
        result->u32MinOutputConnections = 1; result->u32MaxOutputConnections = 1;
        result->u32MaxInstances = 8;
        *properties = result;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE IsInputFormatSupported(IAudioMediaType* output, IAudioMediaType* requested, IAudioMediaType** supported) noexcept override {
        if (supported) *supported = nullptr;
        if (!requested) return E_POINTER;
        const auto* out = output ? output->GetAudioFormat() : nullptr;
        const auto* in = requested->GetAudioFormat();
        if (!in || (output && !out)) return E_INVALIDARG;
        if (out && (out->nChannels != in->nChannels || out->nSamplesPerSec != in->nSamplesPerSec || out->wBitsPerSample != in->wBitsPerSample)) return APOERR_INVALID_CONNECITON_FORMAT;
        if (supported) { *supported = requested; requested->AddRef(); }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE IsOutputFormatSupported(IAudioMediaType* input, IAudioMediaType* requested, IAudioMediaType** supported) noexcept override {
        return IsInputFormatSupported(input, requested, supported);
    }
    HRESULT STDMETHODCALLTYPE GetInputChannelCount(UINT32* count) noexcept override { if (!count) return E_POINTER; *count = m_channels; return S_OK; }
    HRESULT STDMETHODCALLTYPE GetOutputChannelCount(UINT32* count) noexcept override { if (!count) return E_POINTER; *count = m_channels; return S_OK; }

    HRESULT STDMETHODCALLTYPE LockForProcess(UINT32 inputCount, APO_CONNECTION_DESCRIPTOR** inputs, UINT32 outputCount, APO_CONNECTION_DESCRIPTOR** outputs) noexcept override {
        if (m_locked) return APOERR_APO_LOCKED;
        if (inputCount != 1 || outputCount != 1 || !inputs || !outputs || !inputs[0] || !outputs[0] || !inputs[0]->pFormat || !outputs[0]->pFormat) return E_INVALIDARG;
        const auto* in = inputs[0]->pFormat->GetAudioFormat();
        const auto* out = outputs[0]->pFormat->GetAudioFormat();
        if (!in || !out || in->nChannels != out->nChannels || in->nSamplesPerSec != out->nSamplesPerSec || in->wBitsPerSample != out->wBitsPerSample) return APOERR_INVALID_CONNECITON_FORMAT;
        m_channels = in->nChannels;
        m_sampleRate = in->nSamplesPerSec;
        m_blockAlign = in->nBlockAlign;
        m_maxFrames = (inputs[0]->u32MaxFrameCount < outputs[0]->u32MaxFrameCount) ? inputs[0]->u32MaxFrameCount : outputs[0]->u32MaxFrameCount;
        m_float32 = IsFloatFormat(in) && IsFloatFormat(out) && m_channels == 2 && m_sampleRate >= 44100 && m_sampleRate <= 192000;
        if (m_dsp) { tnd_destroy(m_dsp); m_dsp = nullptr; }
        // DSP được tạo lại ở mỗi định dạng nên phải nhận profile shared memory lại.
        m_lastProfileSequence = 0;
        m_profileReady = false;
        if (m_float32) {
            m_dsp = tnd_create(m_sampleRate, 2);
            if (!m_dsp) m_float32 = false;
            m_latency = static_cast<HNSTIME>((static_cast<double>((m_sampleRate * 15ULL + 5000ULL) / 10000ULL) * 10000000.0) / m_sampleRate);
        } else m_latency = 0;
        m_locked = true;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE UnlockForProcess() noexcept override {
        m_locked = false;
        if (m_dsp) { tnd_destroy(m_dsp); m_dsp = nullptr; }
        return S_OK;
    }

    // Những API khung chỉ thông báo số frame; APO in-place không đổi tốc độ/độ dài.
    UINT32 STDMETHODCALLTYPE CalcInputFrames(UINT32 outputFrames) noexcept override { return outputFrames; }
    UINT32 STDMETHODCALLTYPE CalcOutputFrames(UINT32 inputFrames) noexcept override { return inputFrames; }

    void STDMETHODCALLTYPE APOProcess(UINT32 inputCount, APO_CONNECTION_PROPERTY** inputs, UINT32 outputCount, APO_CONNECTION_PROPERTY** outputs) noexcept override {
        if (!outputs || outputCount != 1 || !outputs[0]) return;
        auto* output = outputs[0];
        if (!inputs || inputCount != 1 || !inputs[0]) { output->u32BufferFlags = BUFFER_INVALID; return; }
        auto* input = inputs[0];
        output->u32ValidFrameCount = input->u32ValidFrameCount;
        if (input->u32BufferFlags == BUFFER_SILENT) { output->u32BufferFlags = BUFFER_SILENT; return; }
        if (input->u32BufferFlags != BUFFER_VALID) { output->u32BufferFlags = BUFFER_INVALID; return; }
        output->u32BufferFlags = BUFFER_VALID;
        if (!input->pBuffer || !output->pBuffer) { output->u32BufferFlags = BUFFER_INVALID; return; }
        if (input->pBuffer != output->pBuffer) {
            // Dù đăng ký in-place, nếu host đưa buffer khác nhau thì vẫn chép nguyên tín hiệu.
            if (m_blockAlign == 0) { output->u32BufferFlags = BUFFER_INVALID; return; }
            CopyMemory(reinterpret_cast<void*>(output->pBuffer), reinterpret_cast<const void*>(input->pBuffer), static_cast<SIZE_T>(input->u32ValidFrameCount) * m_blockAlign);
            return;
        }
        // Nếu host đổi trạng thái ngoài dự kiến, giữ buffer hợp lệ ở trạng thái passthrough.
        if (!m_locked || input->u32ValidFrameCount > m_maxFrames) return;
        if (!m_float32 || !m_dsp || !m_view) return;
        ApplySharedProfile();
        if (!m_profileReady) return;
        auto* samples = reinterpret_cast<float*>(output->pBuffer);
        UINT32 remaining = input->u32ValidFrameCount;
        UINT32 offset = 0;
        // Kích thước stack cố định, không dùng heap dù driver gửi block lớn.
        std::array<float, 1024> backup;
        while (remaining) {
            const UINT32 frames = (remaining > 512) ? 512 : remaining;
            const size_t count = static_cast<size_t>(frames) * 2;
            std::memcpy(backup.data(), samples + static_cast<size_t>(offset) * 2, count * sizeof(float));
            if (tnd_process(m_dsp, samples + static_cast<size_t>(offset) * 2, frames) != TND_OK) {
                std::memcpy(samples + static_cast<size_t>(offset) * 2, backup.data(), count * sizeof(float));
            }
            offset += frames; remaining -= frames;
        }
        m_telemetryFrames += input->u32ValidFrameCount;
        if (m_view && m_telemetryFrames >= (m_sampleRate / 30)) WriteTelemetry();
    }

private:
    void ApplySharedProfile() noexcept {
        if (!m_view || !m_dsp) return;
        const LONG64 before = InterlockedCompareExchange64(&m_view->profileSequence, 0, 0);
        if (before == m_lastProfileSequence || (before & 1) != 0) return;
        TndParams snapshot{};
        std::memcpy(&snapshot, &m_view->profile, sizeof(snapshot));
        MemoryBarrier();
        const LONG64 after = InterlockedCompareExchange64(&m_view->profileSequence, 0, 0);
        if (before != after || (after & 1) != 0) return;
        if (tnd_set_params(m_dsp, &snapshot) == TND_OK) { m_lastProfileSequence = after; m_profileReady = true; }
    }
    void WriteTelemetry() noexcept {
        m_telemetryFrames = 0;
        TndTelemetry snapshot{};
        if (tnd_read_telemetry(m_dsp, &snapshot) != TND_OK) return;
        const LONG slot = m_slot % TND_TELEMETRY_SLOTS;
        InterlockedIncrement64(&m_view->telemetrySequence[slot]);
        snapshot.heartbeat = static_cast<uint64_t>(InterlockedIncrement64(&m_heartbeat));
        std::memcpy(&m_view->telemetry[slot], &snapshot, sizeof(snapshot));
        MemoryBarrier();
        InterlockedIncrement64(&m_view->telemetrySequence[slot]);
    }

    volatile LONG m_refs = 1;
    HANDLE m_mapping = nullptr;
    TndSharedBlock* m_view = nullptr;
    TndHandle* m_dsp = nullptr;
    LONG m_slot = 0;
    LONG m_channels = 0;
    UINT32 m_sampleRate = 0;
    UINT32 m_blockAlign = 0;
    UINT32 m_maxFrames = 0;
    UINT32 m_telemetryFrames = 0;
    LONG64 m_lastProfileSequence = 0;
    volatile LONG64 m_heartbeat = 0;
    HNSTIME m_latency = 0;
    bool m_float32 = false;
    bool m_locked = false;
    bool m_profileReady = false;
};

class TaylorClassFactory final : public IClassFactory {
public:
    TaylorClassFactory() noexcept { InterlockedIncrement(&g_objects); }
    ~TaylorClassFactory() { InterlockedDecrement(&g_objects); }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) noexcept override {
        if (!out) return E_POINTER; *out = nullptr;
        if (IsEqualIID(iid, __uuidof(IUnknown)) || IsEqualIID(iid, __uuidof(IClassFactory))) { *out = static_cast<IClassFactory*>(this); AddRef(); return S_OK; }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() noexcept override { return static_cast<ULONG>(InterlockedIncrement(&m_refs)); }
    ULONG STDMETHODCALLTYPE Release() noexcept override { LONG n = InterlockedDecrement(&m_refs); if (!n) delete this; return static_cast<ULONG>(n); }
    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID iid, void** out) noexcept override {
        if (outer) return CLASS_E_NOAGGREGATION;
        auto* object = new (std::nothrow) TaylorApo();
        if (!object) return E_OUTOFMEMORY;
        const HRESULT hr = object->QueryInterface(iid, out); object->Release(); return hr;
    }
    HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) noexcept override { lock ? InterlockedIncrement(&g_serverLocks) : InterlockedDecrement(&g_serverLocks); return S_OK; }
private: volatile LONG m_refs = 1;
};

HRESULT RegisterCom(bool install) noexcept {
    wchar_t module[MAX_PATH]{};
    if (GetModuleFileNameW(reinterpret_cast<HMODULE>(&__ImageBase), module, MAX_PATH) == 0) return HRESULT_FROM_WIN32(GetLastError());
    wchar_t clsid[64]{}; StringFromGUID2(CLSID_TaylorAudioApo, clsid, 64);
    wchar_t keyPath[128]{}; swprintf_s(keyPath, L"CLSID\\%s\\InprocServer32", clsid);
    if (!install) {
        wchar_t parent[96]{}; swprintf_s(parent, L"CLSID\\%s", clsid);
        RegDeleteTreeW(HKEY_CLASSES_ROOT, parent);
        return S_OK;
    }
    HKEY key = nullptr;
    LONG status = RegCreateKeyExW(HKEY_CLASSES_ROOT, keyPath, 0, nullptr, 0, KEY_WRITE, nullptr, &key, nullptr);
    if (status != ERROR_SUCCESS) return HRESULT_FROM_WIN32(status);
    status = RegSetValueExW(key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(module), static_cast<DWORD>((wcslen(module) + 1) * sizeof(wchar_t)));
    if (status == ERROR_SUCCESS) {
        const wchar_t model[] = L"Both";
        status = RegSetValueExW(key, L"ThreadingModel", 0, REG_SZ, reinterpret_cast<const BYTE*>(model), sizeof(model));
    }
    RegCloseKey(key);
    return HRESULT_FROM_WIN32(status);
}
} // namespace

extern "C" __declspec(dllexport) HRESULT WINAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** out) noexcept {
    if (!IsEqualCLSID(clsid, CLSID_TaylorAudioApo)) return CLASS_E_CLASSNOTAVAILABLE;
    auto* factory = new (std::nothrow) TaylorClassFactory();
    if (!factory) return E_OUTOFMEMORY;
    HRESULT hr = factory->QueryInterface(iid, out); factory->Release(); return hr;
}
extern "C" __declspec(dllexport) HRESULT WINAPI DllCanUnloadNow() noexcept { return (g_objects == 0 && g_serverLocks == 0) ? S_OK : S_FALSE; }
extern "C" __declspec(dllexport) HRESULT WINAPI DllRegisterServer() noexcept { return RegisterCom(true); }
extern "C" __declspec(dllexport) HRESULT WINAPI DllUnregisterServer() noexcept { return RegisterCom(false); }
