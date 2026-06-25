!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Preparing Veslo Windows runtime..."
  DetailPrint "Veslo runtime setup logs: $LOCALAPPDATA\Veslo\logs\wsl2-client-installer.log"
  DetailPrint "Veslo prerequisite setup logs: $COMMONAPPDATA\Veslo\logs\wsl2-prerequisite-installer.log"
  DetailPrint "Veslo sandbox setup logs: $LOCALAPPDATA\Veslo\logs\wsl2-sandbox-installer.log"
  ClearErrors
  nsExec::ExecToLog '"powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\wsl2-client-installer.ps1"'
  Pop $0
  DetailPrint "Veslo Windows runtime preparation finished with exit code $0"
  StrCmp $0 0 veslo_runtime_ready
  StrCmp $0 3010 veslo_runtime_restart
  StrCmp $0 1641 veslo_runtime_restart
  DetailPrint "Veslo Windows runtime preparation failed. Check the Veslo runtime setup logs listed above."
  IfSilent +2 0
  MessageBox MB_ICONEXCLAMATION|MB_OK "Veslo installation cannot finish because Windows runtime preparation failed. WSL and VesloSandbox must be prepared before local workspaces can run. See the installer details and Veslo runtime setup logs."
  Abort "Veslo Windows runtime preparation failed. See the Veslo runtime setup logs."
  veslo_runtime_restart:
  SetRebootFlag true
  DetailPrint "Windows restart is required before VesloSandbox provisioning can finish. Veslo registered a startup continuation."
  IfSilent veslo_runtime_done 0
  MessageBox MB_ICONINFORMATION|MB_OK "Windows must restart to finish WSL setup. Veslo registered a startup continuation and will continue preparing VesloSandbox after you sign in again."
  Goto veslo_runtime_done
  veslo_runtime_ready:
  DetailPrint "Veslo Windows runtime is ready."
  veslo_runtime_done:
!macroend
