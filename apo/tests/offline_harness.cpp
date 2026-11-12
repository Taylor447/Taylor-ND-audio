// Harness Windows gọi trực tiếp APO COM: stereo 44.1/48/96 kHz, 6 kênh passthrough, silent.
#include <Windows.h>
#include <mmreg.h>
#include <ksmedia.h>
#include <audioenginebaseapo.h>
#include <audioapotypes.h>
#include <audiomediatype.h>
#include <array>
#include <cassert>
#include <cmath>
#include <cstring>
#include <iostream>
#include "tnd_dsp.h"
#include "tnd_shared.h"

const CLSID kTaylorApo = { 0x8c2d5171, 0x9d77, 0x4f62, { 0x9b, 0x5d, 0x43, 0xa1, 0x6f, 0x8e, 0x31, 0x20 } };
using GetClassObjectFn = HRESULT (WINAPI*)(REFCLSID, REFIID, void**);

IAudioMediaType* MakeFormat(UINT32 rate, UINT16 channels) {
    WAVEFORMATEXTENSIBLE format{};
    format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    format.Format.nChannels = channels;
    format.Format.nSamplesPerSec = rate;
    format.Format.wBitsPerSample = 32;
    format.Format.nBlockAlign = channels * sizeof(float);
    format.Format.nAvgBytesPerSec = rate * format.Format.nBlockAlign;
    format.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    format.Samples.wValidBitsPerSample = 32;
    format.dwChannelMask = channels == 2 ? KSAUDIO_SPEAKER_STEREO : KSAUDIO_SPEAKER_5POINT1;
    format.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    IAudioMediaType* result = nullptr;
    const HRESULT hr = CreateAudioMediaType(&format.Format, sizeof(format), &result);
    assert(SUCCEEDED(hr));
    return result;
}

void RunFormat(IAudioProcessingObject* apo, IAudioProcessingObjectConfiguration* configuration, IAudioProcessingObjectRT* realtime, UINT32 rate, UINT16 channels, const TndParams& params) {
    IAudioMediaType* format = MakeFormat(rate, channels);
    std::array<float, 512 * 8> samples{};
    for (size_t i = 0; i < samples.size(); ++i) samples[i] = 0.1f + static_cast<float>(i % 7) * 0.01f;
    auto before = samples;
    APO_CONNECTION_DESCRIPTOR input{}; input.pFormat = format; input.u32MaxFrameCount = 512; input.pBuffer = reinterpret_cast<UINT_PTR>(samples.data());
    APO_CONNECTION_DESCRIPTOR output = input;
    APO_CONNECTION_DESCRIPTOR* inputList[] = { &input };
    APO_CONNECTION_DESCRIPTOR* outputList[] = { &output };
    assert(SUCCEEDED(configuration->LockForProcess(1, inputList, 1, outputList)));
    APO_CONNECTION_PROPERTY inputProperty{}; inputProperty.pBuffer = reinterpret_cast<UINT_PTR>(samples.data()); inputProperty.u32BufferFlags = BUFFER_VALID; inputProperty.u32ValidFrameCount = 512;
    APO_CONNECTION_PROPERTY outputProperty = inputProperty;
    APO_CONNECTION_PROPERTY* inputProperties[] = { &inputProperty };
    APO_CONNECTION_PROPERTY* outputProperties[] = { &outputProperty };
    TndHandle* reference = channels == 2 ? tnd_create(rate, 2) : nullptr;
    if (reference) assert(tnd_set_params(reference, &params) == TND_OK);
    for (int block = 0; block < 20 && channels == 2; ++block) {
        samples.fill(0.1f);
        std::array<float, 512 * 2> referenceSamples{}; referenceSamples.fill(0.1f);
        realtime->APOProcess(1, inputProperties, 1, outputProperties);
        assert(tnd_process(reference, referenceSamples.data(), 512) == TND_OK);
        samples.fill(0.1f);
    }
    samples = before;
    realtime->APOProcess(1, inputProperties, 1, outputProperties);
    assert(outputProperty.u32ValidFrameCount == 512 && outputProperty.u32BufferFlags == BUFFER_VALID);
    if (channels > 2) assert(samples == before); // Kênh nhiều hơn stereo được fail-open passthrough.
    else {
        std::array<float, 512 * 2> referenceSamples{};
        for (size_t i = 0; i < referenceSamples.size(); ++i) referenceSamples[i] = 0.1f + static_cast<float>(i % 7) * 0.01f;
        assert(tnd_process(reference, referenceSamples.data(), 512) == TND_OK);
        assert(std::memcmp(samples.data(), referenceSamples.data(), referenceSamples.size() * sizeof(float)) == 0);
    }

    inputProperty.u32BufferFlags = BUFFER_SILENT;
    outputProperty.u32BufferFlags = BUFFER_INVALID;
    realtime->APOProcess(1, inputProperties, 1, outputProperties);
    assert(outputProperty.u32BufferFlags == BUFFER_SILENT && outputProperty.u32ValidFrameCount == 512);
    assert(SUCCEEDED(configuration->UnlockForProcess()));
    if (reference) tnd_destroy(reference);
    format->Release();
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) { std::wcerr << L"Dùng: taylor-apo-harness.exe <taylor-apo.dll>\n"; return 2; }
    HMODULE module = LoadLibraryW(argv[1]);
    if (!module) { std::wcerr << L"LoadLibrary thất bại: " << GetLastError() << L"\n"; return 3; }
    const wchar_t mappingName[] = L"Local\\TaylorNDAudio-APO-v1";
    HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(TndSharedBlock), mappingName);
    assert(mapping != nullptr);
    auto* shared = static_cast<TndSharedBlock*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(TndSharedBlock)));
    assert(shared != nullptr);
    ZeroMemory(shared, sizeof(TndSharedBlock));
    shared->magic = TND_SHARED_MAGIC; shared->version = TND_SHARED_VERSION;
    TndParams params{}; params.bypass = 1; params.compressor_ratio = 3.0f; params.compressor_threshold = -18.0f;
    InterlockedIncrement64(&shared->profileSequence);
    shared->profile = params; MemoryBarrier();
    InterlockedIncrement64(&shared->profileSequence);
    auto getFactory = reinterpret_cast<GetClassObjectFn>(GetProcAddress(module, "DllGetClassObject"));
    assert(getFactory != nullptr);
    IClassFactory* factory = nullptr;
    assert(SUCCEEDED(getFactory(kTaylorApo, IID_IClassFactory, reinterpret_cast<void**>(&factory))));
    IAudioProcessingObject* apo = nullptr;
    assert(SUCCEEDED(factory->CreateInstance(nullptr, __uuidof(IAudioProcessingObject), reinterpret_cast<void**>(&apo))));
    factory->Release();
    IAudioProcessingObjectConfiguration* configuration = nullptr;
    IAudioProcessingObjectRT* realtime = nullptr;
    assert(SUCCEEDED(apo->QueryInterface(__uuidof(IAudioProcessingObjectConfiguration), reinterpret_cast<void**>(&configuration))));
    assert(SUCCEEDED(apo->QueryInterface(__uuidof(IAudioProcessingObjectRT), reinterpret_cast<void**>(&realtime))));
    assert(SUCCEEDED(apo->Initialize(0, nullptr)));
    for (UINT32 rate : { 44100u, 48000u, 96000u }) RunFormat(apo, configuration, realtime, rate, 2, params);
    RunFormat(apo, configuration, realtime, 48000, 6, params);
    realtime->Release(); configuration->Release(); apo->Release();
    UnmapViewOfFile(shared); CloseHandle(mapping);
    FreeLibrary(module);
    std::wcout << L"APO offline harness: đạt các trường hợp COM, silent và passthrough.\n";
    return 0;
}
