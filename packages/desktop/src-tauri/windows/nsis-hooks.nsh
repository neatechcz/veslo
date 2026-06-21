!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Preparing Veslo Windows runtime..."
  ClearErrors
  nsExec::ExecToLog '"powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\wsl2-client-installer.ps1"'
  Pop $0
  DetailPrint "Veslo Windows runtime preparation finished with exit code $0"
!macroend
