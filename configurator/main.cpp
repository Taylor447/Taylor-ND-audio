// Công cụ an toàn cho prototype: dò endpoint và đăng ký COM khi được yêu cầu tường minh.
#include <Windows.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>
#include <shellapi.h>
#include <iostream>
#include <string>
#include <vector>

bool IsAdministrator() {
    BOOL elevated = FALSE;
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
    PSID administrators = nullptr;
    if (!AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &administrators)) return false;
    CheckTokenMembership(nullptr, administrators, &elevated);
    FreeSid(administrators);
    return elevated == TRUE;
}

std::wstring ReadEndpointName(IMMDevice* device) {
    IPropertyStore* store = nullptr;
    if (FAILED(device->OpenPropertyStore(STGM_READ, &store))) return L"(không đọc được tên)";
    PROPVARIANT value; PropVariantInit(&value);
    std::wstring result = L"(không có tên)";
    if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR && value.pwszVal) result = value.pwszVal;
    PropVariantClear(&value); store->Release();
    return result;
}

void ListRenderEndpoints() {
    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) { std::wcerr << L"Không khởi tạo được Core Audio: 0x" << std::hex << hr << L"\n"; return; }
    IMMDeviceCollection* collection = nullptr;
    hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE | DEVICE_STATE_DISABLED, &collection);
    if (FAILED(hr)) { std::wcerr << L"Không liệt kê được thiết bị phát.\n"; enumerator->Release(); return; }
    UINT count = 0; collection->GetCount(&count);
    std::wcout << L"Thiết bị phát đang có trên máy:\n";
    for (UINT i = 0; i < count; ++i) {
        IMMDevice* device = nullptr;
        if (FAILED(collection->Item(i, &device))) continue;
        LPWSTR id = nullptr;
        device->GetId(&id);
        DWORD state = 0; device->GetState(&state);
        std::wcout << L"- " << ReadEndpointName(device) << L"\n  endpointId: " << (id ? id : L"(không rõ") << L"\n  state: " << state << L"\n";
        CoTaskMemFree(id); device->Release();
    }
    collection->Release(); enumerator->Release();
}

HRESULT RegisterComServer(const std::wstring& dllPath, bool install) {
    HMODULE module = LoadLibraryW(dllPath.c_str());
    if (!module) return HRESULT_FROM_WIN32(GetLastError());
    using RegisterFn = HRESULT (WINAPI*)();
    auto function = reinterpret_cast<RegisterFn>(GetProcAddress(module, install ? "DllRegisterServer" : "DllUnregisterServer"));
    HRESULT result = function ? function() : HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
    FreeLibrary(module);
    return result;
}

int wmain(int argc, wchar_t** argv) {
    const HRESULT init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(init)) { std::wcerr << L"Không khởi tạo được COM.\n"; return 2; }
    if (argc == 1 || (argc > 1 && std::wstring(argv[1]) == L"--guided")) {
        std::wcout << L"Taylor ND Audio APO · prototype phòng lab\n"
            << L"Đây chưa phải bộ cài APO cho endpoint. Windows yêu cầu APO hiện đại được gắn qua INF/extension package của driver.\n"
            << L"Công cụ này không ghi FxProperties và không bật DisableProtectedAudioDG.\n\n";
        ListRenderEndpoints();
        std::wcout << L"Để thử prototype, dùng VM snapshot và gói INF dành riêng cho thiết bị; không cài trên máy chính.\n";
        CoUninitialize(); return 0;
    }
    if (std::wstring(argv[1]) == L"--list-endpoints") { ListRenderEndpoints(); CoUninitialize(); return 0; }
    if (argc == 4 && std::wstring(argv[1]) == L"--register-com" && std::wstring(argv[2]) == L"--lab-only" && std::wstring(argv[3]) == L"REGISTER-TAYLOR-COM") {
        if (!IsAdministrator()) { std::wcerr << L"Chạy terminal Administrator trong VM snapshot trước.\n"; CoUninitialize(); return 5; }
        wchar_t exe[MAX_PATH]{}; GetModuleFileNameW(nullptr, exe, MAX_PATH);
        std::wstring dll(exe); const auto separator = dll.find_last_of(L"\\/");
        dll.resize(separator == std::wstring::npos ? 0 : separator + 1); dll += L"taylor-apo.dll";
        const HRESULT result = RegisterComServer(dll, true);
        std::wcout << L"Đăng ký COM: 0x" << std::hex << result << L". Điều này không cài APO vào endpoint.\n";
        CoUninitialize(); return FAILED(result) ? 6 : 0;
    }
    if (argc == 4 && std::wstring(argv[1]) == L"--unregister-com" && std::wstring(argv[2]) == L"--lab-only" && std::wstring(argv[3]) == L"UNREGISTER-TAYLOR-COM") {
        if (!IsAdministrator()) { std::wcerr << L"Chạy terminal Administrator trong VM snapshot trước.\n"; CoUninitialize(); return 5; }
        wchar_t exe[MAX_PATH]{}; GetModuleFileNameW(nullptr, exe, MAX_PATH);
        std::wstring dll(exe); const auto separator = dll.find_last_of(L"\\/");
        dll.resize(separator == std::wstring::npos ? 0 : separator + 1); dll += L"taylor-apo.dll";
        const HRESULT result = RegisterComServer(dll, false);
        std::wcout << L"Hủy đăng ký COM: 0x" << std::hex << result << L". Khôi phục registry endpoint cần thực hiện riêng.\n";
        CoUninitialize(); return FAILED(result) ? 6 : 0;
    }
    std::wcerr << L"Không có thao tác cài endpoint an toàn trong prototype này. Dùng --guided để xem giới hạn và thiết bị.\n";
    CoUninitialize(); return 1;
}
