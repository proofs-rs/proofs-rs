"""Run real Creusot/Why3find/provers, then record fresh results with the CLI.

Usage: python3 tests/real_creusot.py target/debug/cargo-proofs OUTPUT_DIRECTORY
OUTPUT_DIRECTORY must not exist. No service requests or publication are made.
Only the GitHub remote advertisement is substituted, as in e2e.py.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    binary = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    output.mkdir(parents=True)
    work = output / 'source'
    shutil.copytree(Path(__file__).parent / 'fixtures/creusot-spec', work)
    (work / 'README.md').unlink()
    (work / '.gitignore').write_text('/target/\n/verif/\n/.why3find/\n')
    real_git = shutil.which('git')
    env = dict(os.environ)

    def run(args, name, expected=0):
        result = subprocess.run(args, cwd=work, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (output / (name + '.log')).write_text(result.stdout)
        assert result.returncode == expected, result.stdout
        print(name + ': PASS', flush=True)
        return result.stdout

    run(['cargo', 'creusot', 'version'], 'versions')
    assert 'cargo-creusot 0.13.0' in (output / 'versions.log').read_text()
    run(['cargo', 'creusot', '--no-cache', '--', '--locked'], 'real-proof')
    proofs = list(work.glob('verif/**/proof.json'))
    assert len(proofs) == 3, proofs
    shutil.copytree(work / 'verif', output / 'real-proof')

    run([str(binary), 'init', '--tool', 'creusot', '--tool-target', 'annotated',
         '--tool-version', '0.13.0'], 'init')
    run([real_git, 'init', '-q'], 'git-init')
    run([real_git, 'config', 'user.name', 'Creusot integration test'], 'git-name')
    run([real_git, 'config', 'user.email', 'test@example.test'], 'git-email')
    run([real_git, 'init', '--bare', '-q', str(output / 'remote.git')], 'git-remote')
    run([real_git, 'remote', 'add', 'origin', str(output / 'remote.git')], 'git-origin')
    run([real_git, 'add', '.'], 'git-add')
    run([real_git, 'commit', '-qm', 'Real Creusot fixture'], 'git-commit')
    run([real_git, 'push', '-q', 'origin', 'HEAD:main'], 'git-push')
    wrapper = output / 'bin'
    wrapper.mkdir()
    git = wrapper / 'git'
    git.write_text('#!/bin/sh\n'
                   'if [ "$PWD" = "$TEST_GIT_PROJECT" ] && [ "$1" = remote ] && [ "$2" = get-url ]; then\n'
                   '  echo https://github.com/fixture/source\n'
                   'else\n  exec "$TEST_REAL_GIT" "$@"\nfi\n')
    git.chmod(0o755)
    env.update(PATH=str(wrapper) + os.pathsep + env['PATH'],
               TEST_REAL_GIT=real_git, TEST_GIT_PROJECT=str(work),
               XDG_DATA_HOME=str(output / 'data'))
    run([str(binary), 'run', '--', 'cargo', 'creusot', '--no-cache'],
        'record')
    records = list((output / 'data').glob('cargo-proofs/*/runs/*/run.sarif.json'))
    assert len(records) == 1, records
    sarif = json.loads(records[0].read_text())['runs'][0]
    assert sarif['invocations'][0]['executionSuccessful'] is True
    contracts = sarif['properties']['proofs']['contracts']
    assert {c['harness'].split('::')[-1] for c in contracts} == {'add_one', 'increment', 'identity'}
    expected_specs = {
        'add_one': {'version': 1, 'signature': 'pub fn add_one(x: u32) -> u32',
                    'requires': ['x@ < u32::MAX@'], 'ensures': ['result@ == x@ + 1']},
        'increment': {'version': 1, 'signature': 'pub fn increment(x: &mut u32)',
                      'requires': ['x@ < u32::MAX@'], 'ensures': ['(^x)@ == (*x)@ + 1']},
        'identity': {'version': 1, 'signature': 'pub fn identity(x: u32) -> u32',
                     'requires': [], 'ensures': ['result == x']},
    }
    for contract in contracts:
        assert contract['formal'] == {**expected_specs[contract['harness'].split('::')[-1]],
                                      'kind': 'creusot', 'source': {key: contract[key] for key in ['file', 'first_line', 'last_line']}}
    assert all(r['kind'] == 'pass' for r in sarif['results'])
    assert {r['properties']['harness'] for r in sarif['results']} == {c['harness'] for c in contracts}
    # All leaves must identify the actual configured prover, including split VCs.
    trees = [r['properties']['proof'] for r in sarif['results']]
    while trees:
        tree = trees.pop()
        if 'tactic' in tree:
            assert tree['children']
            trees.extend(tree['children'])
        else:
            assert tree['prover'] == 'alt-ergo', tree
    shutil.copyfile(records[0], output / 'run.sarif.json')
    # The recorder rejects compilation-only commands before running the tool.
    run([str(binary), 'run', '--', 'cargo', 'creusot', '--only=coma'],
        'compile-only-rejected', expected=1)
    assert 'Unsupported recording option: --only' in (output / 'compile-only-rejected.log').read_text()
    assert len(list((output / 'data').glob('cargo-proofs/*/runs/*/run.sarif.json'))) == 1
    print(f'Real proof and recording: {len(contracts)} APIs, {len(sarif["results"])} VCs; {output}')


if __name__ == '__main__':
    main()
