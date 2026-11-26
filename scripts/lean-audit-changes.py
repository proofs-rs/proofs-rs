"""Decide whether real Lean integration tests are required (fail open to running)."""
import json
import os
from pathlib import Path
import subprocess


PREFIXES = ('cli/src/', 'cli/tests/', 'cli/.cargo/', 'src/', 'migrations/',
            'tests/', 'fixtures/', '.github/workflows/')
FILES = {'cli', '.gitmodules', 'cli/Cargo.toml', 'cli/Cargo.lock', 'Cargo.toml', 'Cargo.lock',
         'package.json', 'package-lock.json', '.npmrc',
         'scripts/prepare-lean-audit.py', 'scripts/lean-audit-changes.py'}


def relevant(path):
    return (path.startswith(PREFIXES) or path in FILES
            or ('/' not in path and path.startswith('tsconfig') and path.endswith('.json')))


def decide(event_name, event, cwd=None):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=cwd)

    if event_name in {'workflow_dispatch', 'schedule'}:
        return True, f'Full audit: {event_name}'
    try:
        if event_name == 'pull_request':
            base = event['pull_request']['base']['sha']
            head = event['pull_request']['head']['sha']
            base = git('merge-base', base, head).decode().strip()
        elif event_name == 'push':
            base, head = event['before'], event['after']
        else:
            return True, 'Full audit: unsupported event'
        # Disable rename detection so both old and new paths participate.
        paths = git('diff', '--name-only', '--no-renames', '-z', base, head, '--')
        changed = [p.decode('utf-8', errors='replace') for p in paths.split(b'\0') if p]
        if any(relevant(path) for path in changed):
            return True, 'Related files changed'
        return False, 'No Lean integration inputs changed'
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError):
        return True, 'Full audit: change comparison unavailable'


def main():
    try:
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        required, reason = decide(os.environ.get('GITHUB_EVENT_NAME'), event)
    except (KeyError, ValueError, OSError):
        required, reason = True, 'Full audit: event data unavailable'
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'required={str(required).lower()}\nreason={reason}\n')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'### Lean audit selection\n{reason}; required: {required}.\n')


if __name__ == '__main__':
    main()
