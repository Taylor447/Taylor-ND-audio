; Trang kết thúc có lựa chọn mở hướng dẫn; không tự động cài/đăng ký APO.
!define MUI_FINISHPAGE_RUN "$INSTDIR\resources\apo\taylor-configurator.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Mở hướng dẫn Taylor APO prototype (chưa cài endpoint)"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchTaylorApoGuide

Function LaunchTaylorApoGuide
  ExecShell "runas" "$INSTDIR\resources\apo\taylor-configurator.exe" "--guided"
FunctionEnd
