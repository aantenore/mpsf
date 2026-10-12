# Runs one approved release.local smoke command inside a fresh, per-run
# AppContainer with no capabilities: no external network, no loopback, and
# writes only inside the container's private storage. The smoke cwd and any
# runtime directory outside the system folders get a temporary read-only ACE
# for the per-run container SID; the ACEs and the profile are removed after
# the run. stdout and stderr are inherited, so they are relayed unchanged, and
# the exit code is the smoke command's own. Any launcher fault exits with 125
# and a message on stderr, so it can never look like a passing smoke run.
#
# This script is hash-sealed into the release.local authorization
# (wrapper_script_sha256) and re-verified immediately before spawn.
param(
  [string]$Request = "",
  [switch]$Probe
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

function Exit-LauncherFault([string]$message) {
  [Console]::Error.WriteLine("windows-appcontainer launcher: $message")
  exit 125
}

if ($ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
  Exit-LauncherFault "PowerShell is not in FullLanguage mode (AppLocker or WDAC policy)."
}

$source = @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AgenticSdlcAppContainer {
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint CREATE_SUSPENDED = 0x00000004;
  const int STARTF_USESTDHANDLES = 0x00000100;
  const uint HANDLE_FLAG_INHERIT = 0x00000001;
  const uint INFINITE = 0xFFFFFFFF;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x00020002;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = (IntPtr)0x00020009;
  const int JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public int CapabilityCount; public int Reserved; }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint capabilityCount, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int DeleteAppContainerProfile(string name);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int GetAppContainerFolderPath(string sidString, out IntPtr path);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr sidString);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertStringSidToSidW(string sidString, out IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok, string what) {
    if (ok) return;
    int error = Marshal.GetLastWin32Error();
    // Name the Windows error with its code, so a failure on the user's host can be diagnosed.
    throw new Win32Exception(error, what + ": " + new Win32Exception(error).Message + " (error " + error + ")");
  }

  public static string CreateProfile(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, "agentic-sdlc release.local smoke test", IntPtr.Zero, 0, out sid);
    if (hr != 0) throw new Win32Exception(hr, "CreateAppContainerProfile");
    try {
      IntPtr text;
      Check(ConvertSidToStringSidW(sid, out text), "ConvertSidToStringSid");
      try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
    } finally { FreeSid(sid); }
  }

  public static void DeleteProfile(string name) {
    int hr = DeleteAppContainerProfile(name);
    if (hr != 0) throw new Win32Exception(hr, "DeleteAppContainerProfile");
  }

  public static string FolderPath(string sidString) {
    IntPtr path;
    int hr = GetAppContainerFolderPath(sidString, out path);
    if (hr != 0) throw new Win32Exception(hr, "GetAppContainerFolderPath");
    try { return Marshal.PtrToStringUni(path); } finally { CoTaskMemFree(path); }
  }

  // CommandLineToArgvW-compatible quoting, so the child sees argv unchanged.
  public static string QuoteArgument(string value) {
    if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
    StringBuilder quoted = new StringBuilder("\"");
    int backslashes = 0;
    foreach (char c in value) {
      if (c == '\\') { backslashes++; continue; }
      if (c == '"') { quoted.Append('\\', backslashes * 2 + 1); quoted.Append('"'); backslashes = 0; continue; }
      quoted.Append('\\', backslashes); backslashes = 0; quoted.Append(c);
    }
    quoted.Append('\\', backslashes * 2);
    quoted.Append('"');
    return quoted.ToString();
  }

  public static int Run(string sidString, string[] argv, string cwd, string[] environment) {
    List<string> quoted = new List<string>();
    foreach (string argument in argv) quoted.Add(QuoteArgument(argument));
    StringBuilder commandLine = new StringBuilder(string.Join(" ", quoted.ToArray()));
    StringBuilder block = new StringBuilder();
    foreach (string entry in environment) { block.Append(entry); block.Append('\0'); }
    block.Append('\0');

    List<IntPtr> handles = new List<IntPtr>();
    foreach (int std in new[] { -10, -11, -12 }) {
      IntPtr handle = GetStdHandle(std);
      if (handle == IntPtr.Zero || handle == (IntPtr)(-1) || handles.Contains(handle)) continue;
      if (SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) handles.Add(handle);
    }

    IntPtr sid = IntPtr.Zero, capabilities = IntPtr.Zero, handleArray = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, environmentBlock = IntPtr.Zero, job = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    try {
      Check(ConvertStringSidToSidW(sidString, out sid), "ConvertStringSidToSid");
      SECURITY_CAPABILITIES security = new SECURITY_CAPABILITIES();
      security.AppContainerSid = sid;
      capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(security));
      Marshal.StructureToPtr(security, capabilities, false);

      int attributeCount = handles.Count > 0 ? 2 : 1;
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref size), "InitializeProcThreadAttributeList");
      Check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, capabilities, (IntPtr)Marshal.SizeOf(security), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(security)");
      if (handles.Count > 0) {
        handleArray = Marshal.AllocHGlobal(IntPtr.Size * handles.Count);
        for (int i = 0; i < handles.Count; i++) Marshal.WriteIntPtr(handleArray, i * IntPtr.Size, handles[i]);
        Check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleArray, (IntPtr)(IntPtr.Size * handles.Count), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(handles)");
      }

      STARTUPINFOEX startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(startup);
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      startup.StartupInfo.hStdInput = GetStdHandle(-10);
      startup.StartupInfo.hStdOutput = GetStdHandle(-11);
      startup.StartupInfo.hStdError = GetStdHandle(-12);
      startup.lpAttributeList = attributes;

      job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
      Check(job != IntPtr.Zero, "CreateJobObject");
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(limits)), "SetInformationJobObject");

      environmentBlock = Marshal.StringToHGlobalUni(block.ToString());
      Check(CreateProcessW(argv[0], commandLine, IntPtr.Zero, IntPtr.Zero, handles.Count > 0,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
        environmentBlock, cwd, ref startup, out process), "CreateProcess");
      if (!AssignProcessToJobObject(job, process.hProcess)) {
        int error = Marshal.GetLastWin32Error();
        TerminateProcess(process.hProcess, 125);
        throw new Win32Exception(error, "AssignProcessToJobObject");
      }
      if (ResumeThread(process.hThread) == 0xFFFFFFFF) {
        int error = Marshal.GetLastWin32Error();
        TerminateProcess(process.hProcess, 125);
        throw new Win32Exception(error, "ResumeThread");
      }
      Check(WaitForSingleObject(process.hProcess, INFINITE) == 0, "WaitForSingleObject");
      uint exitCode;
      Check(GetExitCodeProcess(process.hProcess, out exitCode), "GetExitCodeProcess");
      return unchecked((int)exitCode);
    } finally {
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
      if (handleArray != IntPtr.Zero) Marshal.FreeHGlobal(handleArray);
      if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
      if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
      if (sid != IntPtr.Zero) LocalFree(sid);
    }
  }
}
"@

try {
  Add-Type -TypeDefinition $source -Language CSharp
} catch {
  Exit-LauncherFault "cannot load the AppContainer API: $($_.Exception.Message)"
}

$icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
# The launcher runs with a minimal environment; without .EXE in PATHEXT, PowerShell treats
# icacls.exe as a document and refuses to run it in a pipeline. The smoke process gets its own
# environment below, so this changes only the launcher.
if (-not (@(([string]$env:PATHEXT) -split ";") -contains ".EXE")) {
  $env:PATHEXT = (@(".COM", ".EXE") + @(([string]$env:PATHEXT) -split ";" | Where-Object { $_ })) -join ";"
}
$name = "agentic-sdlc-smoke-" + [Guid]::NewGuid().ToString("N")

if ($Probe) {
  try {
    [void][AgenticSdlcAppContainer]::CreateProfile($name)
    [AgenticSdlcAppContainer]::DeleteProfile($name)
  } catch {
    Exit-LauncherFault "AppContainer profiles are unavailable: $($_.Exception.Message)"
  }
  exit 0
}

try {
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request))
  $spec = ConvertFrom-Json -InputObject $decoded
  $cwd = [string]$spec.cwd
  $argv = [string[]]@($spec.argv)
  $readPaths = [string[]]@($spec.read_paths)
} catch {
  Exit-LauncherFault "invalid request: $($_.Exception.Message)"
}
if (-not $cwd -or $argv.Count -lt 1 -or -not [IO.Path]::IsPathRooted($argv[0])) {
  Exit-LauncherFault "the request needs a cwd and an absolute executable."
}

# System folders already grant ALL APPLICATION PACKAGES read access.
$systemFolders = @(
  [Environment]::GetFolderPath("Windows"),
  [Environment]::GetFolderPath("ProgramFiles"),
  [Environment]::GetFolderPath("ProgramFilesX86")
) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd("\") + "\" }

function Test-UnderSystemFolder([string]$candidate) {
  $full = [IO.Path]::GetFullPath($candidate).TrimEnd("\") + "\"
  foreach ($folder in $systemFolders) {
    if ($full.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

$granted = New-Object System.Collections.Generic.List[string]
$profileCreated = $false
$exitCode = 125
$fault = $null
try {
  $sid = [AgenticSdlcAppContainer]::CreateProfile($name)
  $profileCreated = $true
  foreach ($readPath in $readPaths) {
    if (-not [IO.Directory]::Exists($readPath)) { throw "read path is not a directory: $readPath" }
    if (Test-UnderSystemFolder $readPath) { continue }
    & $icacls $readPath /grant "*${sid}:(OI)(CI)(RX)" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "cannot grant read access to $readPath (icacls exit $LASTEXITCODE)" }
    $granted.Add($readPath)
  }
  $folder = [AgenticSdlcAppContainer]::FolderPath($sid)
  $environment = New-Object System.Collections.Generic.List[string]
  foreach ($key in @("PATH", "SYSTEMROOT", "WINDIR")) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value) { $environment.Add("$key=$value") }
  }
  # CreateProcess for an AppContainer rewrites the profile folders in the child's environment and
  # fails with error 203 when they are absent; the minimal launcher environment has none.
  foreach ($pair in @(@("LOCALAPPDATA", "LocalApplicationData"), @("USERPROFILE", "UserProfile"))) {
    $value = [Environment]::GetFolderPath($pair[1])
    if ($value) { $environment.Add("$($pair[0])=$value") }
  }
  $environment.Add("TEMP=$folder")
  $environment.Add("TMP=$folder")
  $exitCode = [AgenticSdlcAppContainer]::Run($sid, $argv, $cwd, $environment.ToArray())
} catch {
  $fault = $_.Exception.Message
} finally {
  foreach ($readPath in $granted) {
    & $icacls $readPath /remove:g "*$sid" /Q | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not $fault) { $fault = "cannot remove the temporary read access from $readPath" }
  }
  if ($profileCreated) {
    try { [AgenticSdlcAppContainer]::DeleteProfile($name) } catch { if (-not $fault) { $fault = $_.Exception.Message } }
  }
}
if ($fault) { Exit-LauncherFault $fault }
exit $exitCode
