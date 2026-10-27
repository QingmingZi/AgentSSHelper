# Brings the SSHHelper window to the foreground and sends a real Ctrl+V keystroke
# to whatever input is focused in the renderer.
#
# Usage: focus-and-paste.ps1 <clipboardText>
#
# Notes:
#  - This file is intentionally ASCII-only: Windows PowerShell 5.1 decodes BOM-less
#    files using the system ANSI codepage, which corrupts non-ASCII comments and
#    breaks parsing.
#  - keybd_event is used instead of SendKeys because SendKeys frequently drops the
#    CTRL modifier, so the paste never reaches the app.
param(
  [Parameter(Mandatory = $true)][string]$ClipboardText,
  # Activate the native menu bar (F10) before sending Ctrl+V.
  # This reproduces the case where the menu bar owns the focus.
  [switch]$FocusMenu,
  # Only restore the window and bring it to the foreground, then exit.
  # xterm paints through requestAnimationFrame, which does not run while the
  # window is hidden/minimized, so terminal assertions need a visible window.
  [switch]$RestoreOnly
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public static void Tap(ushort vk) {
    keybd_event((byte)vk, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event((byte)vk, 0, 2, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
  }

  public static void Down(ushort vk) { keybd_event((byte)vk, 0, 0, UIntPtr.Zero); }
  public static void Up(ushort vk) { keybd_event((byte)vk, 0, 2, UIntPtr.Zero); }
}
"@

$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*SSHHelper*' } | Select-Object -First 1
if (-not $proc) {
  Write-Output 'NO_WINDOW'
  exit 1
}

$h = $proc.MainWindowHandle

# If the target window is not already the foreground window, use the ALT tap trick
# to bypass the Windows foreground lock.
# IMPORTANT: only do this when the target is NOT foreground. A stray ALT keystroke
# landing on the app would move focus to the native menu bar, which changes what
# the following Ctrl+V actually targets.
if ([Win]::GetForegroundWindow() -ne $h) {
  [Win]::Tap(0x12)
  Start-Sleep -Milliseconds 150
}

[Win]::ShowWindow($h, 9) | Out-Null
[Win]::BringWindowToTop($h) | Out-Null
[Win]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500

if ($RestoreOnly) {
  Write-Output "RESTORED: $($proc.ProcessName) / $($proc.MainWindowTitle)"
  exit 0
}

Set-Clipboard -Value $ClipboardText
Start-Sleep -Milliseconds 250
$clip = Get-Clipboard -Raw
if ($null -eq $clip) { $clip = '' }

if ($FocusMenu) {
  # F10 activates the native menu bar
  [Win]::Tap(0x79)
  Start-Sleep -Milliseconds 300
}

# Ctrl+V
[Win]::Down(0x11)
Start-Sleep -Milliseconds 40
[Win]::Down(0x56)
Start-Sleep -Milliseconds 40
[Win]::Up(0x56)
Start-Sleep -Milliseconds 40
[Win]::Up(0x11)

Start-Sleep -Milliseconds 400
$fg = [Win]::GetForegroundWindow()
Write-Output "SENT_TO: $($proc.ProcessName) / $($proc.MainWindowTitle) / foreground=$($fg -eq $h) / clipboard=$clip / focusMenu=$($FocusMenu.IsPresent)"
