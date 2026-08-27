# Contributing to Auto Accept Antigravity

Thanks for considering contributing! We welcome PRs, bug reports, and feature suggestions.

## Ways to Contribute

### 1. Report a Bug
Found a problem? [File an issue](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/issues):
- Title: Short description
- Description: Steps to reproduce, expected vs actual behavior
- Environment: VS Code version, OS, Auto Accept version

### 2. Suggest a Feature
Have an idea? [Open a discussion](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/discussions):
- What problem does this solve?
- Who benefits?
- Rough implementation ideas

### 3. Submit a Pull Request

#### Setup
```bash
git clone https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt.git
cd Antigravity-AutoAccecpt
npm install
npm run watch  # TypeScript compile in watch mode
```

#### Make Your Changes
1. Create a branch: `git checkout -b feature/my-feature`
2. Edit files in `src/`
3. Test locally (see below)
4. Commit with clear message: `git commit -m "feat: add thing"`

#### Test Locally
```bash
npm run compile    # Build TypeScript
npm run package    # Create .vsix file
# Install .vsix in VS Code manually (Extensions → ... → Install from VSIX)
```

#### PR Guidelines
- One feature per PR
- Clear commit messages
- Update tests if applicable
- Update docs if it affects user-facing behavior
- Link related issues

### 4. Improve Documentation
Docs live in `docs/` folder:
- Typos? Submit a fix
- Unclear explanation? Clarify it
- Missing guide? Write one

---

## Code Style

### TypeScript
- Use `const` by default (not `let` or `var`)
- Prefer simple, direct variable names
- Minimal comments (only why, not what)
- No over-abstraction (keep it simple)

Example:
```typescript
// Good: clear and simple
private isRunning = false;
private toggle(): void {
  this.isRunning ? this.stop() : this.start();
}

// Avoid: over-engineered
private state: 'running' | 'stopped' | 'loading' = 'stopped';
private async transition(action: Action): Promise<StateChange> { ... }
```

### Naming
- Use verb+noun for functions: `checkStatus()`, `fireCommand()`
- Use noun for properties: `isRunning`, `pendingCommands`
- Keep names short but clear

### Comments
Only comment the WHY, not the WHAT:
```typescript
// Good: explains decision
// Fire commands at 400ms to catch notifications faster
const interval = 400;

// Avoid: just states what code does
const interval = 400; // interval of 400
```

### Error Handling
Catch and log, don't swallow:
```typescript
// Good
try { await vscode.commands.executeCommand(cmd); } 
catch (e) { this.log(`cmd failed: ${e}`); }

// Avoid
try { await vscode.commands.executeCommand(cmd); } 
catch { }
```

---

## Testing

No formal tests yet (contributions welcome!).

For now:
1. Manual testing in VS Code
2. Run diagnostics: `Auto Accept: Run Diagnostics`
3. Check output channel for errors

---

## Project Structure

```
src/
├── autoAcceptor.ts      # Core engine (4 strategies)
├── extension.ts         # VS Code extension entry
└── diagnostics.ts       # Diagnostic tools

docs/
├── configuration.md     # Settings reference
├── how-it-works.md      # Technical overview
├── faq.md              # FAQs
└── pricing.md          # Monetization details

examples/
├── basic.json          # Default config
├── aggressive.json     # Fast polling + CDP
├── security-hardened.json  # Extra safety
└── relaxed.json        # Slow polling

package.json            # Extension manifest
tsconfig.json          # TypeScript config
```

---

## Release Process

1. Bump version in `package.json`
2. Update `CHANGELOG.md`
3. Push to `main` branch
4. GitHub Actions publishes to Marketplace automatically

(Maintainers only)

---

## Communication

- **Issues:** Bug reports and feature requests
- **Discussions:** Ideas and questions
- **Email:** support@autoaccept.dev
- **PR reviews:** Respond within 48 hours

---

## Code of Conduct

- Be respectful and inclusive
- No harassment or discrimination
- Assume good intent
- We're all here to help

---

## FAQ for Contributors

### Q: I want to add a 5th strategy. Is that good?
**A:** Discuss in an issue first. The 4 current strategies are designed to cover most cases.

### Q: Can I refactor the polling logic?
**A:** Yes, as long as behavior doesn't change. Keep it simple.

### Q: I found a security issue. What do I do?
**A:** Email security@autoaccept.dev with details. Don't open a public issue.

### Q: I want to change the pricing model.
**A:** Discuss in an issue first. Pricing affects community trust.

### Q: Can I add my own monetization (ads, analytics)?
**A:** No. We keep Auto Accept clean and ad-free.

---

## Recognition

Contributors are recognized in:
- Commit history (GitHub)
- `CONTRIBUTORS.md` (future)
- Release notes

---

**Questions?** Email support@autoaccept.dev or open an issue.

Thanks for contributing! 🙏
