import assert from 'node:assert/strict';
import test from 'node:test';
import { isExtensionWebview, buildPermissionScript } from '../src/cdpFallback';

test('cdpFallback: isExtensionWebview accepts vscode-webview but rejects vscode-file and web targets', () => {
    // 1. Accepts valid extension webviews
    assert.equal(isExtensionWebview({ targetId: '1', type: 'page', url: 'vscode-webview://12345/index.html' }), true);
    assert.equal(isExtensionWebview({ targetId: '2', type: 'page', url: 'vscode-webview://antigravity-panel' }), true);

    // 2. Rejects vscode-file workbench internal targets
    assert.equal(isExtensionWebview({ targetId: '3', type: 'page', url: 'vscode-file://vscode-app/workbench' }), false);
    assert.equal(isExtensionWebview({ targetId: '4', type: 'page', url: 'vscode-file://Users/user/editor.html' }), false);

    // 3. Rejects external web targets
    assert.equal(isExtensionWebview({ targetId: '5', type: 'page', url: 'https://example.com' }), false);
    assert.equal(isExtensionWebview({ targetId: '6', type: 'page', url: 'http://localhost:3000' }), false);
});

test('cdpFallback: buildPermissionScript includes oversized and empty container guards', () => {
    const script = buildPermissionScript([], ['rm -rf'], true, true);
    // Must check oversized text limit (65536)
    assert.ok(script.includes('rawText.length > 65536'));
    assert.ok(script.includes('blocked:container-text-oversized'));

    // Must check missing container text
    assert.ok(script.includes('!containerText.trim()'));
    assert.ok(script.includes('missing-container-text'));

    // Must extract candidates for pre-approval script inspection
    assert.ok(script.includes('candidates'));
    assert.ok(script.includes('status: \'candidate\''));
});

