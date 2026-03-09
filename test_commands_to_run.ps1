<#
.SYNOPSIS
A test script containing commands to verify if the Antigravity Auto-Accept extension
is still intercepting terminal command prompts properly after an update.

.DESCRIPTION
To test the extension, DO NOT just run this script yourself (that only triggers one prompt).
Instead, tell the Antigravity AI Agent:
"Please read test_commands_to_run.ps1 and run each command one-by-one in the terminal."

The extension should automatically click "Run" for all the safe commands.
#>

Write-Host "--- TEST 1: Basic Output ---"
echo "Testing basic terminal output. Does the agent auto-accept this?"

Write-Host "--- TEST 2: Environment Check ---"
node -v
npm -v

Write-Host "--- TEST 3: File System Operations ---"
mkdir test_auto_accept_temp_dir
cd test_auto_accept_temp_dir
echo "Hello from test script" > hello.txt
cat hello.txt
cd ..

Write-Host "--- TEST 4: Cleanup (Safe Deletion) ---"
# Remove-Item is usually NOT in the blocked list by default, so it should be auto-accepted.
Remove-Item -Recurse -Force test_auto_accept_temp_dir

Write-Host "--- TEST 5: BLOCKED Command Test (Should NOT be auto-accepted) ---"
# The extension blocks destructive commands like 'del' and 'rmdir' by default
# Have the agent try to run this command. The extension should IGNORE it and wait for your manual approval.
# rmdir test_auto_accept_temp_dir
