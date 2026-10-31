param([int]$GeneratorPid = 0)
# PID + process start time distinguish counter reset / PID reuse.
$p3Targets = if ($GeneratorPid -gt 0) { @(Get-Process -Id $GeneratorPid -ErrorAction SilentlyContinue) } else { @(Get-Process -Name k6 -ErrorAction SilentlyContinue) }
$p3Generator = @($p3Targets | ForEach-Object {
    @{ pid=$_.Id; started=$_.StartTime.ToUniversalTime().ToString('o'); cpu_seconds=$_.CPU; working_set_bytes=$_.WorkingSet64; private_bytes=$_.PrivateMemorySize64 }
})
# These proxies can include other WSL distros; they are not Docker VM utilization.
$p3Wsl = @(Get-Process -Name vmmem,vmmemWSL -ErrorAction SilentlyContinue | ForEach-Object {
    @{ pid=$_.Id; name=$_.ProcessName; cpu_seconds=$_.CPU; working_set_bytes=$_.WorkingSet64 }
})
ConvertTo-Json -InputObject @{ k6=$p3Generator; wsl_process_proxies=$p3Wsl } -Compress -Depth 4
