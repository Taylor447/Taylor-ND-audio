// Tùy chọn khôi phục độc lập: chỉ nhập bản backup do người dùng chọn trong thư mục app-data.
#include <Windows.h>
#include <shellapi.h>
#include <iostream>
#include <string>

bool IsAdministrator() {
    BOOL elevated = FALSE;
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
    PSID administrators = nullptr;
    if (!AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &administrators)) return false;
    CheckTokenMembership(nullptr, administrators, &elevated);
    FreeSid(administrators);
    return elevated == TRUE;
}

std::wstring Normalize(std::wstring value) {
    for (auto& character : value) if (character == L'/') character = L'\\';
    return value;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 3 || std::wstring(argv[1]) != L"--restore") {
        std::wcerr << L"Dùng: tnd-recover.exe --restore <đường-dẫn-backup.reg> [--restart-audio]\n"
            << L"Chỉ nhập bản backup đã lưu trong %ProgramData%\\TaylorNDAudio\\backup.\n";
        return 2;
    }
    if (!IsAdministrator()) { std::wcerr << L"Mở Command Prompt bằng quyền Administrator rồi chạy lại.\n"; return 3; }
    wchar_t programData[MAX_PATH]{};
    if (!GetEnvironmentVariableW(L"ProgramData", programData, MAX_PATH)) { std::wcerr << L"Không đọc được ProgramData.\n"; return 4; }
    std::wstring allowed = Normalize(programData) + L"\\TaylorNDAudio\\backup\\";
    std::wstring file = Normalize(argv[2]);
    if (file.rfind(allowed, 0) != 0 || file.size() < allowed.size() + 5 || file.substr(file.size() - 4) != L".reg") {
        std::wcerr << L"Từ chối: file phải là .reg bên trong ProgramData\\TaylorNDAudio\\backup.\n"; return 5;
    }
    if (GetFileAttributesW(file.c_str()) == INVALID_FILE_ATTRIBUTES) { std::wcerr << L"Không tìm thấy file backup.\n"; return 6; }
    std::wstring command = L"reg.exe import \"" + file + L"\"";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
    if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
        std::wcerr << L"Không chạy được reg.exe import.\n"; return 7;
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exitCode = 1; GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    if (exitCode != 0) { std::wcerr << L"reg.exe báo lỗi " << exitCode << L"; chưa xác nhận khôi phục.\n"; return static_cast<int>(exitCode); }
    std::wcout << L"Đã nhập bản backup registry. Khởi động lại Windows để nạp lại audio graph.\n";
    bool restart = false;
    for (int i = 3; i < argc; ++i) if (std::wstring(argv[i]) == L"--restart-audio") restart = true;
    if (restart) {
        if (MessageBoxW(nullptr, L"Dừng/khởi động lại Windows Audio có thể làm gián đoạn mọi âm thanh. Tiếp tục?", L"Taylor ND Audio Recovery", MB_YESNO | MB_ICONWARNING) != IDYES) return 0;
        // Nếu dịch vụ bị khóa bởi driver, reboot vẫn là cách khôi phục đáng tin cậy hơn.
        const wchar_t serviceRestart[] = L"cmd.exe /c net stop AudioEndpointBuilder /y & net start AudioEndpointBuilder & net start Audiosrv";
        STARTUPINFOW si{}; si.cb = sizeof(si); PROCESS_INFORMATION pi{};
        if (CreateProcessW(nullptr, const_cast<wchar_t*>(serviceRestart), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
            WaitForSingleObject(pi.hProcess, 30000); CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        } else std::wcerr << L"Không khởi động lại được dịch vụ; hãy khởi động lại Windows.\n";
    }
    return 0;
}
