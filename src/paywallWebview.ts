import * as vscode from 'vscode';

export function showPaywall(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'revenueCatPaywall',
        'AutoAccept Pro - Paywall',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getWebviewContent();

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'success':
                    vscode.window.showInformationMessage('Successfully subscribed to AutoAccept Pro! All background executions unlocked.');
                    // Save entitlement to global state
                    context.globalState.update('autoAcceptAgent.isPro', true);
                    panel.dispose();
                    return;
                case 'error':
                    vscode.window.showErrorMessage(`Subscription error: ${message.text}`);
                    return;
                case 'customerCenter':
                    // Just a mockup command if user wants customer center navigation
                    vscode.window.showInformationMessage('Navigating to Customer Center (Mock)');
                    return;
            }
        },
        undefined,
        context.subscriptions
    );
}

function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AutoAccept Pro Paywall</title>
    <!-- We load the correct modern ES Module SDK via unpkg CDN. This avoids bundler issues in VS Code Webviews where bare npm imports fail -->
    <script type="module">
        // Import the browser version of the RevenueCat SDK directly!
        import { Purchases } from 'https://unpkg.com/@revenuecat/purchases-js@latest/dist/purchases.esm.js';

        const API_KEY = 'test_vseSlppcUVGqgTTxKPYEuVREDsa';
        
        let purchases;
        let activeOfferings;

        // Message passing to extension host
        const vscode = acquireVsCodeApi();

        async function initRevenueCat() {
            try {
                // Initialize the RevenueCat Web SDK
                const appUserId = "web_user_" + Math.random().toString(36).substr(2, 9); // In a real app, use their Github ID!
                purchases = Purchases.configure(API_KEY, appUserId);

                // 1. Get Customer Info
                const customerInfo = await purchases.getCustomerInfo();
                const isPro = customerInfo.entitlements.active['Antigravity Auto Accept Pro'] !== undefined;
                
                if (isPro) {
                    showSuccessMode();
                    vscode.postMessage({ command: 'success' });
                    return;
                }

                // 2. Load the Offerings (Products)
                const offerings = await purchases.getOfferings();
                if (offerings.current !== null && offerings.current.availablePackages.length > 0) {
                    activeOfferings = offerings.current.availablePackages;
                    displayPackages(activeOfferings);
                } else {
                    displayError('No available packages found. Ensure products are set up in the RevenueCat Dashboard.');
                }
            } catch (e) {
                displayError(e.message);
                console.error("RevenueCat Init Error:", e);
            }
        }

        function displayPackages(packages) {
            const container = document.getElementById('packages-container');
            container.innerHTML = '';
            
            packages.forEach(pkg => {
                const btn = document.createElement('button');
                btn.className = 'pkg-button';
                // Monthly, etc. Display the pricing based on the Package object
                btn.innerHTML = \`Subscribe \${pkg.identifier} - \${pkg.rcBillingProduct.currentPrice.currency} \${pkg.rcBillingProduct.currentPrice.amount}\`;
                
                btn.onclick = () => purchasePackage(pkg);
                container.appendChild(btn);
            });
            document.getElementById('loading').style.display = 'none';
        }

        async function purchasePackage(pkg) {
            document.getElementById('status').innerText = 'Processing purchase...';
            try {
                // Best practice: Perform the purchase using the package
                // In a Web context, this will present the RevenueCat Web Billing redirect or modal
                const { customerInfo } = await purchases.purchasePackage(pkg);
                
                // Entitlement Checking best practice
                if (typeof customerInfo.entitlements.active['Antigravity Auto Accept Pro'] !== "undefined") {
                    document.getElementById('status').innerText = 'Purchase successful!';
                    showSuccessMode();
                    vscode.postMessage({ command: 'success', text: 'Subscribed' });
                }
            } catch (e) {
                // Handle user cancellation gracefully
                if (!e.userCancelled) {
                    displayError(\`Purchase Failed: \${e.message}\`);
                    vscode.postMessage({ command: 'error', text: e.message });
                } else {
                    document.getElementById('status').innerText = 'Purchase cancelled.';
                }
            }
        }

        function displayError(msg) {
            document.getElementById('status').innerText = 'Error: ' + msg;
            document.getElementById('status').className = 'error';
            document.getElementById('loading').style.display = 'none';
        }

        function showSuccessMode() {
            document.getElementById('paywall').style.display = 'none';
            document.getElementById('success-view').style.display = 'block';
        }

        function openCustomerCenter() {
            vscode.postMessage({ command: 'customerCenter' });
        }

        // Initialize when DOM loads
        window.addEventListener('load', initRevenueCat);
        window.openCustomerCenter = openCustomerCenter;
    </script>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 40px;
            text-align: center;
        }
        .container {
            max-width: 500px;
            margin: 0 auto;
            border: 1px solid var(--vscode-panel-border);
            padding: 24px;
            border-radius: 8px;
            background-color: var(--vscode-editorWidget-background);
        }
        h1 { font-size: 24px; margin-bottom: 8px; }
        p { margin-bottom: 24px; color: var(--vscode-descriptionForeground); }
        .pkg-button {
            display: block;
            width: 100%;
            padding: 14px;
            margin-bottom: 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            font-size: 16px;
            cursor: pointer;
            transition: opacity 0.2s;
        }
        .pkg-button:hover { opacity: 0.8; }
        .error { color: var(--vscode-errorForeground); margin-top: 10px; }
        #status { margin-top: 15px; font-weight: bold; }
        .success-box { display: none; margin-top: 30px; }
        .link-btn {
            background: none; border: none; color: var(--vscode-textLink-foreground);
            text-decoration: underline; cursor: pointer; margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container" id="paywall">
        <h1>AutoAccept Pro</h1>
        <p>Unlock unlimited background auto-acceptance! 10 free runs consumed.</p>
        
        <div id="loading">Loading products...</div>
        <div id="packages-container"></div>
        <div id="status"></div>
        
        <button class="link-btn" onclick="openCustomerCenter()">Already purchased? Go to Customer Center</button>
    </div>

    <div class="container success-box" id="success-view">
        <h1>🎉 You are Pro!</h1>
        <p>Your Antigravity Auto Accept Pro entitlement is active.</p>
        <button class="link-btn" onclick="openCustomerCenter()">Manage Subscription in Customer Center</button>
    </div>
</body>
</html>`;
}
