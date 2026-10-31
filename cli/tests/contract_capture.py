"""Capture byte-exact production CLI exports for the server contract gate.

The verifier output in e2e.py is synthetic; scanning, concrete compiler probes,
record construction and serialization are real. These files are protocol tests,
not independent proof evidence. No run fields are scrubbed or rewritten.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess


class ContractCapture:
    def __init__(self, destination, binary):
        self.destination = Path(destination).resolve() if destination else None
        self.binary = Path(binary).resolve()
        self.cases = []
        self.registry = json.loads((Path(__file__).parent / 'fixtures/recording-contract-cases.json').read_text())
        if self.destination:
            self.destination.mkdir(parents=True, exist_ok=True)
            if any(self.destination.iterdir()):
                raise RuntimeError('Contract output must be empty; stale corpus is not accepted')

    def run(self, output, accepted, case=None):
        if not self.destination:
            return
        saved = re.search(r'Saved run ([^:]+): (.+)', output)
        if not saved:
            if accepted or case:
                raise RuntimeError('Expected actual CLI SARIF export: ' + str(case))
            return  # Rejected before recording; there are no bytes to consume.
        case = case or f'additional-{len(self.cases):03d}'
        if any(c['id'] == case for c in self.cases):
            raise RuntimeError('Duplicate contract case: ' + case)
        raw = (Path(saved[2]) / 'run.sarif.json').read_bytes()
        file = case + '.sarif.json'
        (self.destination / file).write_bytes(raw)
        self.cases.append({'id': case, 'file': file, 'sha256': hashlib.sha256(raw).hexdigest(),
                           'expect': 'accept' if accepted else 'reject'})

    def finish(self):
        if not self.destination:
            return
        found = {c['id']: c for c in self.cases}
        for case, required in self.registry['cases'].items():
            if case not in found or found[case]['expect'] != required['expect']:
                raise RuntimeError('Missing required producer case: ' + case)
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=Path(__file__).parent, text=True).strip()
        manifest = {'formatVersion': self.registry['formatVersion'],
                    'producer': {'gitRevision': revision,
                                 'recorderVersion': subprocess.check_output([str(self.binary), '--version'], text=True).strip().split()[-1],
                                 'binarySha256': hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                                 'verifiers': 'synthetic; wire contract only'}, 'cases': self.cases}
        (self.destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print('Producer contract corpus:', self.destination / 'manifest.json')
