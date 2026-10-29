import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BLOCKED_COMMANDS } from '../src/catalog';
import { findBlockedPattern } from '../src/blocked';

const blocked = DEFAULT_BLOCKED_COMMANDS;

test('blocks destructive command names and phrases', () => {
    assert.equal(findBlockedPattern('del temp.txt', blocked), 'del');
    assert.equal(findBlockedPattern('> del temp.txt', blocked), 'del');
    assert.equal(findBlockedPattern('format E:', blocked), 'format');
    assert.equal(findBlockedPattern('Format E:', blocked), 'format');
    assert.equal(findBlockedPattern('Remove-Item -Recurse foo', blocked), 'Remove-Item');
    assert.equal(findBlockedPattern('git push --force origin', blocked), 'git push --force');
    assert.equal(findBlockedPattern('sudo rm -rf /tmp', blocked), 'rm -rf');
    assert.equal(findBlockedPattern('rm -rf /', blocked), 'rm -rf /');
    assert.equal(findBlockedPattern('cmd /c "del temp.txt"', blocked), 'del');
    assert.equal(findBlockedPattern('powershell.exe -NoProfile -Command Remove-Item foo', blocked), 'Remove-Item');
    assert.equal(findBlockedPattern('bash -lc "rm -rf /var"', blocked), 'rm -rf');
    assert.equal(findBlockedPattern('echo ok && del temp.txt', blocked), 'del');
    assert.equal(findBlockedPattern('C:\\Windows\\System32\\format.com E:', blocked), 'format');
});

test('blocks the same text when it is sitting in a UI snippet', () => {
    const snippet = 'Agent wants to run this:\nrm -rf /\n';
    assert.equal(findBlockedPattern(snippet, blocked), 'rm -rf /');
});

test('does not block lookalike safe commands', () => {
    assert.equal(findBlockedPattern('git format-patch HEAD~1', blocked), null);
    assert.equal(findBlockedPattern('git push --force-with-lease', blocked), null);
    assert.equal(findBlockedPattern('echo hello', blocked), null);
    assert.equal(findBlockedPattern('npx prettier --write src', blocked), null);
    assert.equal(findBlockedPattern('Do you want to format the document?', blocked), null);
    assert.equal(findBlockedPattern('forward the card', blocked), null);
    assert.equal(findBlockedPattern('git status', blocked), null);
});

test('empty input does not match', () => {
    assert.equal(findBlockedPattern('', blocked), null);
    assert.equal(findBlockedPattern('del file', []), null);
});

test('normalizes flags to catch equivalent destructive invocations', () => {
    // rm flag combinations
    assert.equal(findBlockedPattern('rm -fr ./important', blocked), 'rm -rf');
    assert.equal(findBlockedPattern('rm -r -f ./important', blocked), 'rm -rf');
    assert.equal(findBlockedPattern('rm -f -r ./important', blocked), 'rm -rf');
    assert.equal(findBlockedPattern('rm --recursive --force ./important', blocked), 'rm -rf');
    assert.equal(findBlockedPattern('rm --force --recursive ./important', blocked), 'rm -rf');
    assert.equal(findBlockedPattern('rm -r ./important', blocked), 'rm -r');
    assert.equal(findBlockedPattern('rm --recursive ./important', blocked), 'rm -r');

    // git push flags
    assert.equal(findBlockedPattern('git push -f origin main', blocked), 'git push --force');
    assert.equal(findBlockedPattern('git push --force origin main', blocked), 'git push --force');

    // git clean flags
    assert.equal(findBlockedPattern('git clean -f', blocked), 'git clean -f');
    assert.equal(findBlockedPattern('git clean -fd', blocked), 'git clean -fd');
    assert.equal(findBlockedPattern('git clean -f -d', blocked), 'git clean -fd');
    assert.equal(findBlockedPattern('git clean -d -f', blocked), 'git clean -fd');
    assert.equal(findBlockedPattern('git clean --force', blocked), 'git clean -f');

    // shred
    assert.equal(findBlockedPattern('shred -u secret.txt', blocked), 'shred');
});

test('passes reviewer audit test cases without evasion or false alarms', () => {
    // 1. Literal rm -rf
    assert.equal(findBlockedPattern('rm -rf ./fixture', blocked), 'rm -rf');
    // 2. Transposed flags rm -fr
    assert.equal(findBlockedPattern('rm -fr ./fixture', blocked), 'rm -rf');
    // 3. Separated flags rm -r -f
    assert.equal(findBlockedPattern('rm -r -f ./fixture', blocked), 'rm -rf');
    // 4. Long flags rm --recursive --force
    assert.equal(findBlockedPattern('rm --recursive --force ./fixture', blocked), 'rm -rf');
    // 5. Executable path /bin/rm -rf
    assert.equal(findBlockedPattern('/bin/rm -rf ./fixture', blocked), 'rm -rf');
    // 6. git push with remote before force flag
    assert.equal(findBlockedPattern('git push origin --force', blocked), 'git push --force');
    assert.equal(findBlockedPattern('git push origin -f', blocked), 'git push --force');
    // 7. git with global -C option before destructive command
    assert.equal(findBlockedPattern('git -C ./fixture reset --hard', blocked), 'git reset --hard');
    // 8. echo printing destructive command text is not a command execution (no false alarm)
    assert.equal(findBlockedPattern('echo rm -rf ./fixture', blocked), null);
    assert.equal(findBlockedPattern('printf "rm -rf ./fixture\\n"', blocked), null);
});

test('aggressive and relaxed presets retain general destructive command coverage', () => {
    const aggressive = JSON.parse(fs.readFileSync(path.join(__dirname, '../../examples/aggressive.json'), 'utf8'));
    const relaxed = JSON.parse(fs.readFileSync(path.join(__dirname, '../../examples/relaxed.json'), 'utf8'));
    assert.equal(findBlockedPattern('rm -rf ./fixture', aggressive['autoAcceptAgent.blockedCommands']), 'rm -rf');
    assert.equal(findBlockedPattern('rm -rf ./fixture', relaxed['autoAcceptAgent.blockedCommands']), 'rm -rf');
    assert.equal(findBlockedPattern('rm -fr ./fixture', aggressive['autoAcceptAgent.blockedCommands']), 'rm -rf');
    assert.equal(findBlockedPattern('git push origin --force', relaxed['autoAcceptAgent.blockedCommands']), 'git push --force');
});



