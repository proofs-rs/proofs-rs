import { test } from "node:test";
import { execFileSync } from "node:child_process";

test("Lean audit selection uses real Git history and fails open", () => {
  execFileSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import importlib.util
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('changes', 'scripts/lean-audit-changes.py')
changes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(changes)
for path in ['cli', '.gitmodules', 'cli/src/aeneas_probe.lean', 'cli/tests/fixtures/x', 'cli/Cargo.lock',
             'cli/Cargo.toml', 'cli/.cargo/config.toml', 'src/runs.ts', 'migrations/1.sql',
             'tests/app.test.ts', 'fixtures/x', 'package.json', 'package-lock.json',
             'tsconfig.web.json', 'scripts/prepare-lean-audit.py',
             'scripts/lean-audit-changes.py', '.github/workflows/cli.yml']:
    assert changes.relevant(path), path
for path in ['README.md', 'cli/README.md', 'docs/lean.md', 'book/src/index.md',
             'public/logo.svg', 'web/main.ts', 'index.html']:
    assert not changes.relevant(path), path
for event in ['workflow_dispatch', 'schedule', 'unknown']:
    assert changes.decide(event, {})[0]
assert changes.decide('pull_request', {})[0]

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=root).decode().strip()
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Test')
    def commit(path, text):
        p = root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        git('add', '.')
        git('commit', '-qm', 'fixture')
        return git('rev-parse', 'HEAD')
    def push(base, head):
        return changes.decide('push', {'before': base, 'after': head}, root)[0]
    initial = commit('src/a.ts', 'original')
    docs = commit('README.md', 'docs')
    assert not push(initial, docs)
    assert push('0' * 40, docs)
    git('switch', '-qc', 'topic')
    head = commit('README.md', 'PR docs')
    git('switch', '-q', 'main')
    base = commit('src/a.ts', 'base-only change')
    # A direct base/head diff would incorrectly include src/a.ts.
    assert not changes.decide('pull_request', {'pull_request': {
        'base': {'sha': base}, 'head': {'sha': head}}}, root)[0]
    git('mv', 'src/a.ts', 'moved.md')
    git('commit', '-qm', 'rename out of relevant directory')
    renamed = git('rev-parse', 'HEAD')
    assert push(base, renamed)
    git('mv', 'moved.md', 'src/b.ts')
    git('commit', '-qm', 'rename into relevant directory')
    renamed_back = git('rev-parse', 'HEAD')
    assert push(renamed, renamed_back)
    git('rm', '-q', 'src/b.ts')
    git('commit', '-qm', 'delete relevant file')
    assert push(renamed_back, git('rev-parse', 'HEAD'))
    assert push(initial, git('rev-parse', 'HEAD'))
`,
    ],
    { stdio: "pipe" },
  );
});
