<#
.SYNOPSIS
    Commands for a manual Auto Accept check.

.DESCRIPTION
    Ask the agent to run each command one by one.
    Safe commands should be approved.
    del / rmdir / Remove-Item should be stopped by the blocklist.
#>

Write-Host "--- TEST 1: Basic Output ---"
echo "Testing basic terminal output."

Write-Host "--- TEST 2: Environment Check ---"
node -v
npm -v

Write-Host "--- TEST 3: File System Operations ---"
mkdir test_auto_accept_temp_dir
cd test_auto_accept_temp_dir
echo "Hello from test script" > hello.txt
Get-Content hello.txt
cd ..

Write-Host "--- TEST 4: BLOCKED cleanup ---"
# Remove-Item, del, and rmdir are on the default blocklist.
# The agent should not be allowed to finish these while Auto Accept is on.
# Remove-Item -Recurse -Force test_auto_accept_temp_dir
