param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Executable,

    [Parameter(Mandatory = $true, Position = 1)]
    [string] $ArgumentsBase64,

    [Parameter(Mandatory = $true, Position = 2)]
    [string] $WorkingDirectory
)

$ErrorActionPreference = 'Stop'
$script:MaximumProtocolLineLength = 4096
$script:MaximumProtocolIdLength = 128
$script:MaximumProtocolErrorLength = 512

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace DshDesktop.WindowsJobController
{
    // 统一持有 Win32 内核句柄，并确保控制器退出时调用 CloseHandle。
    public sealed class SafeKernelHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        // 创建供 P/Invoke 返回值使用的空句柄包装器。
        public SafeKernelHandle() : base(true)
        {
        }

        // 立即接管 CreateProcessW 返回的原始句柄。
        public static SafeKernelHandle TakeOwnership(IntPtr handle)
        {
            SafeKernelHandle owned = new SafeKernelHandle();
            owned.SetHandle(handle);
            return owned;
        }

        // 释放当前包装器唯一持有的内核句柄。
        protected override bool ReleaseHandle()
        {
            return NativeMethods.CloseHandle(handle);
        }
    }

    // 描述可继承标准流句柄所需的安全属性。
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    // 描述 CreateProcessW 的窗口与标准流启动设置。
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    // 接收 CreateProcessW 创建的进程、线程和标识符。
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    // 描述 Job Object 的基础限制字段。
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    // 描述 Job Object 的进程与内存计费限制。
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    // 承载启用 KILL_ON_JOB_CLOSE 所需的扩展限制信息。
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    // 承载查询 Job Object 活跃进程数所需的计费信息。
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    // 集中声明控制器使用的 Win32 API，并封装结构体级操作。
    public static class NativeMethods
    {
        public const uint CREATE_SUSPENDED = 0x00000004;
        public const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
        public const uint STARTF_USESTDHANDLES = 0x00000100;
        public const uint GENERIC_READ = 0x80000000;
        public const uint GENERIC_WRITE = 0x40000000;
        public const uint FILE_SHARE_READ = 0x00000001;
        public const uint FILE_SHARE_WRITE = 0x00000002;
        public const uint OPEN_EXISTING = 3;
        public const uint CTRL_BREAK_EVENT = 1;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        public const uint WAIT_OBJECT_0 = 0x00000000;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectExtendedLimitInformation = 9;

        // 创建没有名称冲突风险的私有 Job Object。
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeKernelHandle CreateJobObject(IntPtr jobAttributes, string name);

        // 为 Job Object 写入 KILL_ON_JOB_CLOSE 扩展限制。
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            SafeKernelHandle job,
            int informationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
            int informationLength);

        // 查询 Job Object 当前的基础计费信息。
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            SafeKernelHandle job,
            int informationClass,
            out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
            int informationLength,
            IntPtr returnLength);

        // 将仍处于挂起状态的根进程原子地纳入 Job Object。
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(
            SafeKernelHandle job,
            SafeKernelHandle process);

        // 创建挂起的新进程组，使 Job 接管发生在任何子进程执行之前。
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CreateProcess(
            string applicationName,
            System.Text.StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        // 打开继承给子进程的 NUL 标准流句柄。
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeKernelHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        // 在 Job 接管完成后恢复根进程唯一的初始线程。
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(SafeKernelHandle thread);

        // 在 Job 接管失败时终止尚未恢复的根进程。
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool TerminateProcess(SafeKernelHandle process, uint exitCode);

        // 有界等待接管失败后的 suspended 根进程真正退出。
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(SafeKernelHandle handle, uint milliseconds);

        // 仅向以根进程 PID 标识的新进程组发送 CTRL_BREAK。
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

        // 强制终止 Job Object 内仍存活的所有进程。
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool TerminateJobObject(SafeKernelHandle job, uint exitCode);

        // 释放所有 SafeKernelHandle 最终持有的 Win32 内核句柄。
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);

        // 开启 Job Object 的关闭即杀树语义。
        public static void EnableKillOnClose(SafeKernelHandle job)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    ref limits,
                    Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        // 返回 Job Object 当前仍活跃的进程总数。
        public static uint GetActiveProcessCount(SafeKernelHandle job)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            if (!QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformation,
                    out accounting,
                    Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                    IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return accounting.ActiveProcesses;
        }

        // 将最近一次 Win32 失败转换为包含系统错误说明的异常。
        public static Win32Exception LastError()
        {
            return new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
'@

# 按 CommandLineToArgvW 兼容规则引用单个 Windows 命令行参数。
function ConvertTo-WindowsCommandLineArgument {
    param([AllowEmptyString()][string] $Argument)

    if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') {
        return $Argument
    }

    $quoted = New-Object System.Text.StringBuilder
    [void] $quoted.Append('"')
    $backslashCount = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $backslashCount += 1
            continue
        }
        if ($character -eq '"') {
            [void] $quoted.Append(('\' * (($backslashCount * 2) + 1)))
            [void] $quoted.Append('"')
            $backslashCount = 0
            continue
        }
        if ($backslashCount -gt 0) {
            [void] $quoted.Append(('\' * $backslashCount))
            $backslashCount = 0
        }
        [void] $quoted.Append($character)
    }
    if ($backslashCount -gt 0) {
        [void] $quoted.Append(('\' * ($backslashCount * 2)))
    }
    [void] $quoted.Append('"')
    return $quoted.ToString()
}

# 解码并严格验证只包含字符串的 JSON argv 数组。
function ConvertFrom-Base64Arguments {
    param([string] $EncodedArguments)

    $json = [System.Text.Encoding]::UTF8.GetString(
        [System.Convert]::FromBase64String($EncodedArguments)
    )
    $trimmed = $json.Trim()
    if (-not ($trimmed.StartsWith('[') -and $trimmed.EndsWith(']'))) {
        throw 'argv JSON must be an array'
    }

    $arguments = @($json | ConvertFrom-Json)
    foreach ($argument in $arguments) {
        if ($null -eq $argument -or $argument -isnot [string]) {
            throw 'argv JSON must contain only strings'
        }
    }
    return ,$arguments
}

# 拼出 CreateProcessW 所需且可写的完整命令行。
function New-ProcessCommandLine {
    param(
        [string] $Application,
        [string[]] $Arguments
    )

    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add((ConvertTo-WindowsCommandLineArgument $Application))
    foreach ($argument in $Arguments) {
        $parts.Add((ConvertTo-WindowsCommandLineArgument $argument))
    }
    return New-Object System.Text.StringBuilder ($parts -join ' ')
}

# 逐字符读取一行，避免无界 ReadLine 为恶意输入分配任意内存。
function Read-BoundedProtocolLine {
    param([System.IO.TextReader] $Reader)

    $line = New-Object System.Text.StringBuilder
    $tooLong = $false
    while ($true) {
        $value = $Reader.Read()
        if ($value -eq -1) {
            if ($line.Length -eq 0 -and -not $tooLong) {
                return $null
            }
            break
        }
        $character = [char] $value
        if ($character -eq "`n") {
            break
        }
        if ($character -eq "`r") {
            continue
        }
        if ($line.Length -lt $script:MaximumProtocolLineLength) {
            [void] $line.Append($character)
        }
        else {
            $tooLong = $true
        }
    }

    return [pscustomobject] @{
        Line = $line.ToString()
        TooLong = $tooLong
    }
}

# 从输入前缀提取可安全回显的有界请求 ID。
function Get-SafeProtocolId {
    param([string] $Line)

    if ($Line -match ('^([^\s]{1,' + $script:MaximumProtocolIdLength + '})(?:\s|$)')) {
        return $Matches[1]
    }
    return '?'
}

# 将异常压缩为不会破坏单行协议的有界错误文本。
function ConvertTo-ProtocolError {
    param([System.Exception] $Exception)

    $message = $Exception.Message -replace '[\r\n\t]+', ' '
    if ($message.Length -gt $script:MaximumProtocolErrorLength) {
        return $message.Substring(0, $script:MaximumProtocolErrorLength)
    }
    return $message
}

# 向 stdout 写入一条完整协议响应并立即刷新。
function Write-ProtocolLine {
    param(
        [System.IO.TextWriter] $Writer,
        [string] $Line
    )

    $Writer.WriteLine($Line)
    $Writer.Flush()
}

# 创建挂起进程、接管 Job Object，并在恢复线程后返回根 PID。
function Start-JobControlledProcess {
    param(
        [DshDesktop.WindowsJobController.SafeKernelHandle] $Job,
        [string] $Application,
        [string[]] $Arguments,
        [string] $CurrentDirectory
    )

    $security = New-Object DshDesktop.WindowsJobController.SECURITY_ATTRIBUTES
    $security.nLength = [Runtime.InteropServices.Marshal]::SizeOf(
        [type] [DshDesktop.WindowsJobController.SECURITY_ATTRIBUTES]
    )
    $security.bInheritHandle = $true

    $nullInput = $null
    $nullOutput = $null
    $process = $null
    $thread = $null
    $processOwnershipTransferred = $false
    try {
        $nullInput = [DshDesktop.WindowsJobController.NativeMethods]::CreateFile(
            'NUL',
            [DshDesktop.WindowsJobController.NativeMethods]::GENERIC_READ,
            [DshDesktop.WindowsJobController.NativeMethods]::FILE_SHARE_READ -bor
                [DshDesktop.WindowsJobController.NativeMethods]::FILE_SHARE_WRITE,
            [ref] $security,
            [DshDesktop.WindowsJobController.NativeMethods]::OPEN_EXISTING,
            0,
            [IntPtr]::Zero
        )
        if ($nullInput.IsInvalid) {
            throw [DshDesktop.WindowsJobController.NativeMethods]::LastError()
        }
        $nullOutput = [DshDesktop.WindowsJobController.NativeMethods]::CreateFile(
            'NUL',
            [DshDesktop.WindowsJobController.NativeMethods]::GENERIC_WRITE,
            [DshDesktop.WindowsJobController.NativeMethods]::FILE_SHARE_READ -bor
                [DshDesktop.WindowsJobController.NativeMethods]::FILE_SHARE_WRITE,
            [ref] $security,
            [DshDesktop.WindowsJobController.NativeMethods]::OPEN_EXISTING,
            0,
            [IntPtr]::Zero
        )
        if ($nullOutput.IsInvalid) {
            throw [DshDesktop.WindowsJobController.NativeMethods]::LastError()
        }

        $startup = New-Object DshDesktop.WindowsJobController.STARTUPINFO
        $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf(
            [type] [DshDesktop.WindowsJobController.STARTUPINFO]
        )
        $startup.dwFlags = [DshDesktop.WindowsJobController.NativeMethods]::STARTF_USESTDHANDLES
        $startup.hStdInput = $nullInput.DangerousGetHandle()
        $startup.hStdOutput = $nullOutput.DangerousGetHandle()
        $startup.hStdError = $nullOutput.DangerousGetHandle()
        $processInformation = New-Object DshDesktop.WindowsJobController.PROCESS_INFORMATION
        $commandLine = New-ProcessCommandLine $Application $Arguments
        $flags = [DshDesktop.WindowsJobController.NativeMethods]::CREATE_SUSPENDED -bor
            [DshDesktop.WindowsJobController.NativeMethods]::CREATE_NEW_PROCESS_GROUP

        $created = [DshDesktop.WindowsJobController.NativeMethods]::CreateProcess(
            $Application,
            $commandLine,
            [IntPtr]::Zero,
            [IntPtr]::Zero,
            $true,
            $flags,
            [IntPtr]::Zero,
            $CurrentDirectory,
            [ref] $startup,
            [ref] $processInformation
        )
        if (-not $created) {
            throw [DshDesktop.WindowsJobController.NativeMethods]::LastError()
        }

        $process = [DshDesktop.WindowsJobController.SafeKernelHandle]::TakeOwnership(
            $processInformation.hProcess
        )
        $thread = [DshDesktop.WindowsJobController.SafeKernelHandle]::TakeOwnership(
            $processInformation.hThread
        )
        if (-not [DshDesktop.WindowsJobController.NativeMethods]::AssignProcessToJobObject(
                $Job,
                $process)) {
            $assignError = [DshDesktop.WindowsJobController.NativeMethods]::LastError()
            $terminateError = $null
            if (-not [DshDesktop.WindowsJobController.NativeMethods]::TerminateProcess($process, 1)) {
                $terminateError = [DshDesktop.WindowsJobController.NativeMethods]::LastError()
            }
            $waitResult = [DshDesktop.WindowsJobController.NativeMethods]::WaitForSingleObject(
                $process,
                2000
            )
            if ($waitResult -ne [DshDesktop.WindowsJobController.NativeMethods]::WAIT_OBJECT_0) {
                if ($null -ne $terminateError) {
                    throw $terminateError
                }
                throw "assign-failure root did not exit within 2000ms (wait=$waitResult)"
            }
            throw $assignError
        }
        $resumeResult = [DshDesktop.WindowsJobController.NativeMethods]::ResumeThread($thread)
        if ($resumeResult -eq [uint32]::MaxValue) {
            throw [DshDesktop.WindowsJobController.NativeMethods]::LastError()
        }
        $processOwnershipTransferred = $true
        return [pscustomobject] @{
            ProcessId = [uint32] $processInformation.dwProcessId
            ProcessHandle = $process
        }
    }
    finally {
        if ($null -ne $thread) { $thread.Dispose() }
        if (-not $processOwnershipTransferred -and $null -ne $process) { $process.Dispose() }
        if ($null -ne $nullOutput) { $nullOutput.Dispose() }
        if ($null -ne $nullInput) { $nullInput.Dispose() }
    }
}

# 执行有界控制协议，直到 stdin 关闭或空 Job 收到 EXIT。
function Invoke-ControllerProtocol {
    param(
        [DshDesktop.WindowsJobController.SafeKernelHandle] $Job,
        [uint32] $RootProcessId,
        [System.IO.TextReader] $Reader,
        [System.IO.TextWriter] $Writer
    )

    Write-ProtocolLine $Writer ("READY {0}" -f $RootProcessId)
    while ($true) {
        $request = Read-BoundedProtocolLine $Reader
        if ($null -eq $request) {
            return
        }
        $id = Get-SafeProtocolId $request.Line
        if ($request.TooLong) {
            Write-ProtocolLine $Writer ("{0} ERROR line-too-long" -f $id)
            continue
        }
        if ($request.Line -notmatch ('^([^\s]{1,' + $script:MaximumProtocolIdLength + '}) (STATUS|STOP|FORCE|EXIT)$')) {
            Write-ProtocolLine $Writer ("{0} ERROR invalid-request" -f $id)
            continue
        }

        $id = $Matches[1]
        $command = $Matches[2]
        try {
            if ($command -eq 'STOP') {
                if (-not [DshDesktop.WindowsJobController.NativeMethods]::GenerateConsoleCtrlEvent(
                        [DshDesktop.WindowsJobController.NativeMethods]::CTRL_BREAK_EVENT,
                        $RootProcessId)) {
                    throw [DshDesktop.WindowsJobController.NativeMethods]::LastError()
                }
            }
            elseif ($command -eq 'FORCE') {
                if (-not [DshDesktop.WindowsJobController.NativeMethods]::TerminateJobObject($Job, 1)) {
                    throw [DshDesktop.WindowsJobController.NativeMethods]::LastError()
                }
            }

            $activeCount = [DshDesktop.WindowsJobController.NativeMethods]::GetActiveProcessCount($Job)
            if ($command -eq 'EXIT' -and $activeCount -ne 0) {
                Write-ProtocolLine $Writer ("{0} ERROR activeCount={1}" -f $id, $activeCount)
                continue
            }
            Write-ProtocolLine $Writer ("{0} OK {1}" -f $id, $activeCount)
            if ($command -eq 'EXIT') {
                return
            }
        }
        catch {
            $errorText = ConvertTo-ProtocolError $_.Exception
            Write-ProtocolLine $Writer ("{0} ERROR {1}" -f $id, $errorText)
        }
    }
}

$job = $null
$rootProcess = $null
try {
    $arguments = ConvertFrom-Base64Arguments $ArgumentsBase64
    $job = [DshDesktop.WindowsJobController.NativeMethods]::CreateJobObject(
        [IntPtr]::Zero,
        $null
    )
    if ($job.IsInvalid) {
        throw [DshDesktop.WindowsJobController.NativeMethods]::LastError()
    }
    [DshDesktop.WindowsJobController.NativeMethods]::EnableKillOnClose($job)
    $controlledProcess = Start-JobControlledProcess $job $Executable $arguments $WorkingDirectory
    $rootProcess = $controlledProcess.ProcessHandle
    Invoke-ControllerProtocol $job $controlledProcess.ProcessId ([Console]::In) ([Console]::Out)
}
catch {
    [Console]::Error.WriteLine((ConvertTo-ProtocolError $_.Exception))
    exit 1
}
finally {
    if ($null -ne $rootProcess) {
        $rootProcess.Dispose()
    }
    if ($null -ne $job) {
        $job.Dispose()
    }
}
