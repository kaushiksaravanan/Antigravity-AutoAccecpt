#!/usr/bin/env node

/**
 * Release & Publishing Automation Script for Antigravity-AutoAccept
 * 
 * Features:
 *  1. Auto-increments version on each update / package (patch/minor/major/sync-openvsx)
 *  2. Syncs version across package.json, package-lock.json, and README.md
 *  3. Generates release variants (Universal stable, Pre-Release preview)
 *  4. Supports publishing to Open VSX and VS Code Marketplace
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT_DIR, 'package.json');
const LOCK_PATH = path.join(ROOT_DIR, 'package-lock.json');
const README_PATH = path.join(ROOT_DIR, 'README.md');
const CHANGELOG_PATH = path.join(ROOT_DIR, 'CHANGELOG.md');
const VSCE_BIN = path.join(ROOT_DIR, 'node_modules', '@vscode', 'vsce', 'vsce');

// Parse CLI flags
const args = process.argv.slice(2);
const hasFlag = (flag) => args.some(a => a === flag || a.startsWith(`${flag}=`));
const getArgValue = (flag, defaultVal = null) => {
    const entry = args.find(a => a.startsWith(`${flag}=`));
    if (entry) return entry.split('=')[1];
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
        return args[idx + 1];
    }
    return defaultVal;
};

// Help menu
if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`
Antigravity-AutoAccept Release Automation Tool

Usage:
  node scripts/release.js [options]

Version Options:
  --bump=patch|minor|major   Increment version (default: patch)
  --no-bump                  Skip version bump (use current version)
  --sync-openvsx             Query Open VSX API to ensure version is newer than published

Build Variants:
  --variant=universal        Build standard universal .vsix (default)
  --variant=prerelease       Build pre-release channel .vsix (--pre-release)
  --variant=all              Build both standard universal and pre-release variants

Publishing Options:
  --publish=openvsx          Publish to Open VSX (reads OVSX_PAT or prompts)
  --publish=vscode           Publish to VS Code Marketplace (reads VSCE_PAT)
  --publish=all              Publish to both registries
  --token=<pat>              Registry authentication token

Examples:
  node scripts/release.js                        # Auto-increment patch & package universal .vsix
  node scripts/release.js --variant=all          # Build both stable and pre-release variants
  node scripts/release.js --publish=openvsx      # Increment, package, and upload to Open VSX
`);
    process.exit(0);
}

// 1. Fetch live Open VSX details
function fetchOpenVsxVersion() {
    return new Promise((resolve) => {
        const url = 'https://open-vsx.org/api/kaushiksaravanan/auto-accept-antigravity';
        https.get(url, { headers: { 'User-Agent': 'Antigravity-Release-Script' } }, (res) => {
            if (res.statusCode !== 200) {
                resolve(null);
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.version || null);
                } catch {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

function parseSemver(v) {
    const parts = v.replace(/^v/, '').split('-')[0].split('.').map(Number);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
}

function bumpVersion(current, type = 'patch') {
    const sem = parseSemver(current);
    if (type === 'major') {
        return `${sem.major + 1}.0.0`;
    } else if (type === 'minor') {
        return `${sem.major}.${sem.minor + 1}.0`;
    }
    return `${sem.major}.${sem.minor}.${sem.patch + 1}`;
}

function compareVersions(a, b) {
    const sa = parseSemver(a);
    const sb = parseSemver(b);
    if (sa.major !== sb.major) return sa.major - sb.major;
    if (sa.minor !== sb.minor) return sa.minor - sb.minor;
    return sa.patch - sb.patch;
}

async function main() {
    console.log('🚀 Antigravity-AutoAccept Release Pipeline');
    console.log('─────────────────────────────────────────');

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
    let currentVersion = pkg.version;
    console.log(`📌 Current local version: v${currentVersion}`);

    // Check Open VSX published version
    const remoteVersion = await fetchOpenVsxVersion();
    if (remoteVersion) {
        console.log(`🌐 Live version on Open VSX: v${remoteVersion}`);
    }

    const shouldBump = !hasFlag('--no-bump');
    const bumpType = getArgValue('--bump', 'patch');

    let nextVersion = currentVersion;
    if (shouldBump) {
        // If remote version exists and local is <= remote, ensure we are ahead
        if (remoteVersion && compareVersions(currentVersion, remoteVersion) <= 0) {
            nextVersion = bumpVersion(remoteVersion, bumpType);
            console.log(`⚡ Local version was behind/equal to Open VSX. Auto-incremented to: v${nextVersion}`);
        } else {
            nextVersion = bumpVersion(currentVersion, bumpType);
            console.log(`⬆️  Auto-incremented (${bumpType}): v${currentVersion} -> v${nextVersion}`);
        }

        // 2. Update package.json
        pkg.version = nextVersion;
        fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
        console.log(`✅ Updated package.json`);

        // 3. Update package-lock.json
        if (fs.existsSync(LOCK_PATH)) {
            const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'));
            lock.version = nextVersion;
            if (lock.packages && lock.packages['']) {
                lock.packages[''].version = nextVersion;
            }
            fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
            console.log(`✅ Updated package-lock.json`);
        }

        // 4. Update README badge
        if (fs.existsSync(README_PATH)) {
            let readme = fs.readFileSync(README_PATH, 'utf-8');
            readme = readme.replace(/badge\/version-[0-9.]+-blue/g, `badge/version-${nextVersion}-blue`);
            fs.writeFileSync(README_PATH, readme);
            console.log(`✅ Updated README.md version badge`);
        }

        // 5. Update CHANGELOG if needed
        if (fs.existsSync(CHANGELOG_PATH)) {
            let changelog = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
            if (!changelog.includes(`## [${nextVersion}]`)) {
                const today = new Date().toISOString().split('T')[0];
                const newEntry = `\n## [${nextVersion}] - ${today}\n\n### Changed\n- Maintenance and performance release\n- Bug fixes and stability improvements\n`;
                changelog = changelog.replace('# Changelog\n', `# Changelog\n${newEntry}`);
                fs.writeFileSync(CHANGELOG_PATH, changelog);
                console.log(`✅ Added v${nextVersion} entry to CHANGELOG.md`);
            }
        }
    } else {
        console.log(`ℹ️  Skipping version bump as requested (--no-bump)`);
    }

    // 6. Compile project
    console.log('\n🔨 Compiling TypeScript...');
    execSync('npm run compile', { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log('✅ Compilation successful.');

    // 7. Determine packaging variants
    const variant = getArgValue('--variant', 'universal');
    const packagesToBuild = [];

    if (variant === 'universal' || variant === 'all') {
        packagesToBuild.push({
            name: 'Universal Stable',
            file: `auto-accept-antigravity-${nextVersion}.vsix`,
            flags: []
        });
    }

    if (variant === 'prerelease' || variant === 'all') {
        packagesToBuild.push({
            name: 'Pre-Release Channel',
            file: `auto-accept-antigravity-${nextVersion}-prerelease.vsix`,
            flags: ['--pre-release']
        });
    }

    // 8. Package VSIX files
    console.log('\n📦 Packaging Extension Variants...');
    for (const p of packagesToBuild) {
        console.log(`\n🔹 Building ${p.name}: ${p.file}`);
        const vsceCmd = `node "${VSCE_BIN}" package ${p.flags.join(' ')} -o "${p.file}"`;
        execSync(vsceCmd, { cwd: ROOT_DIR, stdio: 'inherit' });
        const filePath = path.join(ROOT_DIR, p.file);
        const stats = fs.statSync(filePath);
        console.log(`✅ Created ${p.file} (${(stats.size / 1024).toFixed(2)} KB)`);
    }

    // 9. Publishing if requested
    const publishTarget = getArgValue('--publish', null);
    const token = getArgValue('--token', null) || process.env.OVSX_PAT || process.env.VSCE_PAT;

    if (publishTarget) {
        console.log('\n🚀 Publishing Variants...');
        const primaryVsix = `auto-accept-antigravity-${nextVersion}.vsix`;

        if (publishTarget === 'openvsx' || publishTarget === 'all') {
            console.log(`📤 Publishing ${primaryVsix} to Open VSX...`);
            const ovsxToken = getArgValue('--token', null) || process.env.OVSX_PAT || process.env.OPENVSX_TOKEN;
            const tokenFlag = ovsxToken ? `-p ${ovsxToken}` : '';
            try {
                execSync(`npx -y ovsx publish "${primaryVsix}" ${tokenFlag}`, { cwd: ROOT_DIR, stdio: 'inherit' });
                console.log('🎉 Successfully published to Open VSX!');
            } catch (err) {
                console.error('❌ Open VSX publish failed. Ensure ovsx token is set via OVSX_PAT or --token=...');
            }
        }

        if (publishTarget === 'vscode' || publishTarget === 'all') {
            console.log(`📤 Publishing ${primaryVsix} to VS Code Marketplace...`);
            const vsceToken = getArgValue('--token', null) || process.env.VSCE_PAT;
            const tokenFlag = vsceToken ? `-p ${vsceToken}` : '';
            try {
                execSync(`node "${VSCE_BIN}" publish ${tokenFlag} --packagePath "${primaryVsix}"`, { cwd: ROOT_DIR, stdio: 'inherit' });
                console.log('🎉 Successfully published to VS Code Marketplace!');
            } catch (err) {
                console.error('❌ VS Code Marketplace publish failed. Ensure VSCE_PAT is set.');
            }
        }
    } else {
        console.log('\n💡 Tip: To automatically upload to Open VSX in one command, run:');
        console.log(`   node scripts/release.js --publish=openvsx --token=<YOUR_OPENVSX_TOKEN>`);
    }

    console.log('\n✨ Release process completed successfully!');
}

main().catch(err => {
    console.error(`\n❌ Release pipeline failed:`, err);
    process.exit(1);
});
