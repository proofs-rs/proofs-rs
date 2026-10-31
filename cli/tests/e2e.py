"""Exercise the real binary against local Git + an in-memory proofs.rs API."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contract_capture import ContractCapture

binary = str(Path(sys.argv[1]).resolve())
capture = ContractCapture(os.environ.get('PROOFS_CONTRACT_OUTPUT'), binary)
fixture_token = 'f' * 64
contract_aeneas_version = None
reports = {}
history = {}
keys = {}
next_claim = 0
polls = 0
lose_reply = False
race = False


def normalize(body):
    result = copy.deepcopy(body)
    for field in ['title', 'explanation', 'trusted_assumptions', 'environment', 'evidence_url', 'limitations']:
        result.setdefault(field, '')
    for claim in result['claims']:
        claim.setdefault('id', None)
        for field in ['title', 'explanation', 'trusted_assumptions', 'limitations', 'evidence_url']:
            claim.setdefault(field, '')
        if not claim['title']:
            claim['title'] = f"Verification of {claim['api_item_id']}"
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        assert self.headers.get('Authorization') == 'Bearer ' + fixture_token
        if self.path == '/api/v1/me':
            return self.reply(200, {'user': {'id': 'author'}})
        if self.path == '/api/v1/tools':
            return self.reply(200, {'items': [{'id': 'kani', 'name': 'Kani', 'active': 1}, {'id': 'creusot', 'name': 'Creusot', 'active': 1}, {'id': 'aeneas', 'name': 'Aeneas', 'active': 1}], 'versions': [{'id': 'kani-version', 'tool_id': 'kani', 'version': '0.66.0', 'selectable': 1}, {'id': 'creusot-version', 'tool_id': 'creusot', 'version': '0.9.0', 'selectable': 1}, {'id': 'aeneas-version', 'tool_id': 'aeneas', 'version': contract_aeneas_version or 'a' * 40, 'selectable': 1}]})
        if self.path.startswith('/api/v1/resolve-api?'):
            from urllib.parse import parse_qs, urlparse
            path = parse_qs(urlparse(self.path).query)['path'][0].removeprefix('fixture::')
            if path not in ['f', 'g']:
                return self.reply(404, {'error': 'api_not_found'})
            return self.reply(200, {'id': 'api-' + path})
        if self.path.startswith('/api/v1/reports/'):
            parts = self.path.split('/')
            report_id = int(parts[4])
            result = history[(report_id, int(parts[6]))] if len(parts) > 5 else reports[report_id]
            return self.reply(200, result)
        raise AssertionError(self.path)

    def do_POST(self):
        global next_claim, polls, lose_reply, race
        raw = self.rfile.read(int(self.headers['Content-Length']))
        if self.path.endswith('/sarif') or self.path == '/api/v1/runs/prepare':
            assert self.headers.get('Authorization') == 'Bearer ' + fixture_token
            sarif = json.loads(raw)['runs'][0]
            assert sarif['properties']['proofs']['contracts']
            assert sarif['properties']['proofs']['schemaVersion'] == 2
            assert isinstance(sarif['properties']['proofs']['dependencies'], list)
            assert self.path == '/api/v1/runs/prepare' or sarif['automationDetails']['guid'] in self.path
            assert sarif['versionControlProvenance'][0]['revisionId']
            assert sarif['artifacts'][sarif['invocations'][0]['stdout']['index']]['contents']['text']
            assert not any(a.get('contents') for a in sarif['artifacts'][:-2])
            ingestion = os.environ.get('PROOFS_CONTRACT_INGESTION_URL')
            if ingestion:
                from urllib.request import Request, urlopen
                from urllib.error import HTTPError
                request = Request(ingestion + self.path, data=raw, method='POST', headers={
                    'Authorization': 'Bearer ' + fixture_token, 'Content-Type': 'application/sarif+json'})
                try:
                    with urlopen(request, timeout=30) as response:
                        return self.reply(response.status, json.loads(response.read()))
                except HTTPError as error:
                    return self.reply(error.code, json.loads(error.read()))
            bindings = []
            for i, contract in enumerate(sarif['properties']['proofs']['contracts']):
                path = contract['api_paths'][0]
                bindings.append({'contract_index': i, 'api_item_id': 'api-'+path.removeprefix('fixture::'), 'display_path': path, 'origin': 'rustdoc'})
            return self.reply(200 if self.path.endswith('/prepare') else 201, {'id': sarif['automationDetails']['guid'], 'sha256': 'fixture', 'apis': bindings})
        body = json.loads(raw)
        assert not self.path.startswith('/api/v1/runs/'), 'Run registration must be one SARIF upload'
        if self.path == '/auth/device/code':
            assert body == {'client_id': 'proofs-cli', 'scope': 'publish'}
            return self.reply(200, {'device_code': 'fixture-device', 'user_code': 'ABCD-EFGH', 'verification_uri': origin + '/device', 'expires_in': 60, 'interval': 1})
        if self.path == '/auth/device/token':
            polls += 1
            assert body['device_code'] == 'fixture-device'
            if polls == 1:
                return self.reply(400, {'error': 'authorization_pending'})
            return self.reply(200, {'access_token': fixture_token, 'expires_in': 3600})
        assert self.headers.get('Authorization') == 'Bearer ' + fixture_token
        if self.path == '/api/v1/tokens/revoke':
            return self.reply(200, {'ok': True})
        if self.path == '/api/v1/publish/prepare':
            return self.reply(200, {'status': 'ready'})
        if self.path == '/api/v1/reports/validate':
            assert body['title']
            assert 1 <= len(body['claims']) <= 200
            if race:
                race = False
                web_edit()
            return self.reply(200, normalize(body))
        key = self.headers['Idempotency-Key']
        if key in keys:
            assert keys[key][0] == body, 'idempotency key reused with changed payload'
            return self.reply(201, keys[key][1])
        if self.path == '/api/v1/reports':
            report_id, revision = len(reports) + 1, 1
        else:
            report_id = int(self.path.split('/')[4])
            if body['expected_revision'] != reports[report_id]['revision_no']:
                return self.reply(409, {'error': 'conflict'})
            revision = body['expected_revision'] + 1
        result = normalize(body)
        for claim in result['claims']:
            if not claim['id']:
                next_claim += 1
                claim['id'] = f'claim-{next_claim}'
        result.update(id=report_id, revision_no=revision, author_id='author', withdrawn_at=None)
        reports[report_id] = result
        history[report_id, revision] = copy.deepcopy(result)
        response = {'id': report_id, 'revision_no': revision}
        keys[key] = (body, response)
        if lose_reply:
            lose_reply = False
            return self.reply(500, {'error': 'simulated_lost_reply_after_commit'})
        self.reply(201, response)


def web_edit():
    report = reports[1]
    report['title'] = 'Web title'
    report['claims'][0]['title'] = 'Preserve my claim title'
    report['revision_no'] += 1
    history[1, report['revision_no']] = copy.deepcopy(report)


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    work = root / 'work'
    work.mkdir()
    real_git = shutil.which('git')

    def git(*args):
        return subprocess.run([real_git, *args], cwd=work, check=True, capture_output=True, text=True).stdout.strip()

    git('init', '-q')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.test')
    git('init', '--bare', '-q', str(root / 'remote.git'))
    git('remote', 'add', 'origin', str(root / 'remote.git'))
    (work / 'src').mkdir()
    (work / 'Cargo.toml').write_text('[package]\nname="fixture"\nversion="1.0.0"\nedition="2021"\n')
    # Preserve Cargo metadata's lock file behavior without making it an unrelated dirty file.
    (work / '.gitignore').write_text('/target/\n/Cargo.lock\n')
    source = '#[cfg_attr(kani, kani::requires(x > 0))]\npub fn f(x:u8) {}\n#[cfg(kani)]\n#[kani::proof_for_contract(f)]\nfn check_f() {}\n'
    extra = 'pub fn g() {}\n#[cfg(kani)]\n#[kani::proof_for_contract(g)]\nfn check_g() {}\n'
    (work / 'src/lib.rs').write_text(source)
    wrapper = root / 'bin'
    wrapper.mkdir()
    script = wrapper / 'git'
    # Only fake GitHub's advertised URL. Fetch/ancestry checks use the real local remote.
    script.write_text('#!/bin/sh\nif [ "$PWD" = "$TEST_GIT_PROJECT" ] && [ "$1" = remote ] && [ "$2" = get-url ]; then\n echo https://github.com/fixture/source\nelse\n exec "$TEST_REAL_GIT" "$@"\nfi\n')
    script.chmod(0o755)
    env = dict(os.environ, PATH=str(wrapper) + os.pathsep + os.environ['PATH'], TEST_REAL_GIT=real_git, TEST_GIT_PROJECT=str(work.resolve()), PROOFS_CONFIG_DIR=str(root / 'credentials'))
    env['XDG_DATA_HOME'] = str(root / 'data')
    # Exercise aliased temporary roots on every Unix runner, including Linux.
    # macOS normally uses /var paths whose canonical form starts /private/var.
    (root / 'real-tmp').mkdir()
    (root / 'alias-tmp').symlink_to(root / 'real-tmp', target_is_directory=True)
    env['TMPDIR'] = str(root / 'alias-tmp')
    tool = wrapper / 'cargo-kani'
    tool.write_text(r"""#!/usr/bin/env python3
import sys,re,pathlib,os
if '--version' in sys.argv:
    print('kani 0.66.0');sys.exit(0)
source=pathlib.Path('src/lib.rs').read_text()
if os.getenv('TEST_MUTATE_SOURCE'):
    pathlib.Path('src/lib.rs').write_text(source+'// changed input\n')
for harness in re.findall(r'fn (check_\w+)\(',source):
    print('Checking harness fixture::'+harness+'...')
    print('RESULTS:')
    print('Check 1: f.pointer.1')
    print(' - Status: SUCCESS')
    print(' - Description: "pointer check"')
    print('VERIFICATION:- SUCCESSFUL')
""")
    tool.chmod(0o755)
    creusot = wrapper / 'cargo-creusot'
    creusot.write_text("""#!/usr/bin/env python3
import sys,pathlib,json
if 'version' in sys.argv:
    print('creusot 0.9.0');sys.exit(0)
for name in ['f','g']:
    p=pathlib.Path('verif/fixture_rlib')/name/'proof.json'
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps({'proofs':{'M':{'vc_'+name:{'prover':'z3','time':0.1}}}}))
print('Proved (2 files)')
""")
    creusot.chmod(0o755)
    lake = wrapper / 'lake'
    lake.write_text("""#!/usr/bin/env python3
import sys,os,json
if 'build' in sys.argv[1:]:
    assert '+Proofs' in sys.argv
    if os.getenv('TEST_LAKE_FAIL'): sys.exit(1)
    __import__('pathlib').Path('.proofs-toolchain/aeneas/backends/lean/.lake/build/lib/lean').mkdir(parents=True,exist_ok=True) if __import__('pathlib').Path('.proofs-toolchain/aeneas').exists() else None
    print('Built Proofs')
elif sys.argv[1:] == ['env','lean','--version']:
    print('Lean (version 4.35.0, synthetic wire checker)')
elif sys.argv[1:] == ['env','printenv','LEAN_PATH']:
    print(__import__('pathlib').Path('.proofs-toolchain/aeneas/backends/lean/.lake/build/lib/lean').resolve())
else:
    assert sys.argv[1:] == ['env', 'lean', '--stdin']
    source = sys.stdin.read()
    assert 'import Proofs' in source
    assert 'Lean.collectAxioms' in source and 'some (.thmInfo _)' in source
    if os.getenv('TEST_LEAN_FAIL'):
        print('Unapproved axiom in fixture.f_spec: sorryAx');sys.exit(1)
    extra = __import__('pathlib').Path('contract-lean.json')
    if extra.exists():
        for formal in json.loads(extra.read_text()): print('proofs.rs:formal:' + json.dumps(formal))
        sys.exit(0)
    print('proofs.rs:formal:' + json.dumps({'version':2 if os.getenv('TEST_WIRE_MISMATCH') else 1,'theorem':'fixture.f_spec',
        'module':'Proofs','statement':'True','binders':[],'conclusion':'True',
        'program':None,'program_head':None,'axioms':[],'first_line':2,'last_line':2,
        'definitions':[],'definitions_truncated':False,'translation_rerun':False}))
""")
    lake.chmod(0o755)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    origin = f'http://127.0.0.1:{server.server_port}'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    last_latest = None

    def cli(*args, ok=True, case=None):
        global last_latest
        output = subprocess.run([binary, 'proofs', '--server', origin, *args], cwd=work, env=env, input='', capture_output=True, text=True, timeout=30)
        assert (output.returncode == 0) == ok, (args, output.stdout, output.stderr)
        if args[0] == 'run':
            if output.returncode == 0:
                saved = __import__('re').search(r'Saved run [^:]+: (.+)', output.stdout)
                latest = Path(saved[1]).parent.parent / 'latest.json'
                last_latest = (latest, latest.read_bytes())
            elif last_latest:
                assert last_latest[0].read_bytes() == last_latest[1], 'Rejected run changed latest'
                assert 'Saved run ' not in output.stdout
            if not ok and case != 'failed-recording-contract':
                assert 'Server-side changes are required' not in output.stderr
            capture.run(output.stdout + output.stderr, output.returncode == 0, case)
        return output.stdout + output.stderr

    def commit_push():
        subprocess.run(['cargo', 'metadata', '--format-version', '1'], cwd=work, env=env, check=True, capture_output=True)
        git('add', 'src/lib.rs', 'Cargo.toml', '.gitignore', 'proofs.toml')
        git('add', '-f', 'Cargo.lock')
        git('commit', '-qm', 'fixture change')
        git('push', '-q', 'origin', 'HEAD:refs/heads/main')

    try:
        cli('init', '--title', 'My report', '--tool-version', '0.66.0')
        cli('login', '--no-browser')
        git('add', 'src/lib.rs', 'Cargo.toml', '.gitignore')
        git('commit', '-qm', 'fixture')
        assert 'No recorded run' in cli('publish', ok=False)
        assert 'Commit and push' in cli('run', '--', 'cargo', 'kani', ok=False)
        commit_push()
        cli('run', '--', 'cargo', 'kani', case='kani')
        assert len(git('worktree', 'list', '--porcelain').split('worktree ')) == 2
        env['TEST_MUTATE_SOURCE'] = '1'
        assert 'Tracked inputs changed' in cli('run', '--', 'cargo', 'kani', ok=False, case='failed-mutated-source')
        assert (work / 'src/lib.rs').read_text() == source
        assert len(git('worktree', 'list', '--porcelain').split('worktree ')) == 2
        del env['TEST_MUTATE_SOURCE']
        cli('run', '--', 'cargo', 'kani')
        for recorded in (root / 'data').rglob('run.sarif.json'):
            assert sorted(p.name for p in recorded.parent.iterdir()) == ['run.sarif.json']
        # Nothing generated by run requires a push.
        cli('publish', '--dry-run')
        assert not reports
        cli('publish')
        assert len(reports[1]['claims']) == 1
        original_ids = [c['id'] for c in reports[1]['claims']]
        assert all(c['precondition'] == '(x > 0)' for c in reports[1]['claims'])
        assert all(c['evidence_url'].startswith('https://github.com/fixture/source/blob/') and '/src/lib.rs#L' in c['evidence_url'] for c in reports[1]['claims'])
        assert 'No changes' in cli('publish')
        assert reports[1]['revision_no'] == 1
        web_edit()
        assert 'conflict' in cli('publish', ok=False)
        cli('publish', '--force')
        assert [c['id'] for c in reports[1]['claims']] == original_ids
        assert reports[1]['claims'][0]['title'] == 'Preserve my claim title'
        (work / 'src/lib.rs').write_text(source + extra)
        assert 'No changes' in cli('publish')  # Still publishes the frozen recorded source.
        commit_push()
        cli('run', '--', 'cargo', 'kani')
        cli('publish')
        added_ids = [c['id'] for c in reports[1]['claims'][1:]]
        assert len(reports[1]['claims']) == 2
        (work / 'src/lib.rs').write_text(source)
        commit_push()
        cli('run', '--', 'cargo', 'kani')
        assert 'Deletion requires confirmation' in cli('publish', ok=False)
        cli('publish', '--yes')
        assert len(reports[1]['claims']) == 1
        (work / 'src/lib.rs').write_text(source + extra)
        commit_push()
        cli('run', '--', 'cargo', 'kani')
        cli('publish')
        assert [c['id'] for c in reports[1]['claims'][1:]] == added_ids
        (work / 'proofs.toml').write_text((work / 'proofs.toml').read_text().replace('My report', 'Changed report'))
        race = True
        assert '409' in cli('publish', ok=False)
        # Definite conflict cleared its pending journal; a fresh forced publish works.
        cli('publish', '--force')
        (work / 'proofs.toml').write_text((work / 'proofs.toml').read_text().replace('Changed report', 'Retry report'))
        lose_reply = True
        assert '--resume' in cli('publish', ok=False)
        revision = reports[1]['revision_no']
        assert 'interrupted publication' in cli('publish', ok=False)
        cli('publish', '--resume')
        assert reports[1]['revision_no'] == revision
        assert 'No changes' in cli('publish')
        # A new crate version starts a separate report using the Creusot adapter.
        manifest = work / 'Cargo.toml'
        manifest.write_text(manifest.read_text().replace('1.0.0', '1.0.1'))
        (work / 'proofs.toml').unlink()
        cli('init', '--tool', 'creusot', '--tool-target', 'annotated', '--tool-version', '0.9.0')
        (work / 'src/lib.rs').write_text(
            '#[cfg_attr(creusot, requires(x@ > 0))]\npub fn f(x: u32) {}\n'
            'pub fn g() {}\n#[trusted] pub fn ignored() {}\n'
            '#[logic] pub fn model(x: u32) -> Int { x@ }\n')
        commit_push()
        cli('run', '--', 'cargo', 'creusot', 'prove', case='creusot-annotated')
        cli('publish', '--dry-run')
        assert len(reports) == 1
        cli('publish')
        assert reports[2]['tool_version_id'] == 'creusot-version'
        assert len(reports[2]['claims']) == 1
        claim = reports[2]['claims'][0]
        assert claim['precondition'] == '(x@ > 0)'
        assert '/blob/' in claim['evidence_url'] and '/src/lib.rs#L' in claim['evidence_url']
        assert 'No changes' in cli('publish')
        config = work / 'proofs.toml'
        config.write_text(config.read_text().replace('target = "annotated"', 'target = "all"'))
        commit_push()
        cli('run', '--', 'cargo', 'creusot', 'prove', case='creusot-all')
        cli('publish')
        assert len(reports[2]['claims']) == 2
        assert reports[2]['claims'][1]['precondition'] == 'true'
        config.write_text(config.read_text().replace('target = "all"', 'target = "annotated"'))
        commit_push()
        cli('run', '--', 'cargo', 'creusot', 'prove')
        assert 'Deletion requires confirmation' in cli('publish', ok=False)
        cli('publish', '--yes')
        assert reports[2]['claims'][0]['id'] == claim['id']
        # Aeneas uses committed Lean evidence and explicit API/theorem mappings.
        manifest.write_text(manifest.read_text().replace('1.0.1', '1.0.2'))
        config.unlink()
        cli('init', '--tool', 'aeneas', '--tool-version', 'a' * 40)
        config.write_text(config.read_text() + "\n[[tool.proofs]]\napi='f'\nmodule='Proofs'\ntheorem='fixture.f_spec'\nprecondition='x > 0'\n")
        (work / 'src/lib.rs').write_text('pub fn f(x: u32) {}\n')
        (work / 'Proofs.lean').write_text('namespace fixture\ntheorem f_spec : True := by trivial\nend fixture\n')
        (work / 'lean-toolchain').write_text('leanprover/lean4:v4.35.0\n')
        (work / 'lakefile.toml').write_text('name="fixture"\n[[lean_lib]]\nname="Proofs"\n')
        (work / 'lake-manifest.json').write_text(json.dumps({'packages': [{
            'name': 'aeneas', 'type': 'git', 'url': 'https://github.com/AeneasVerif/aeneas',
            'rev': 'a' * 40, 'subDir': 'backends/lean'}]}))
        # The manifest stays outside the submodule, as in the adler2 harness.
        upstream = root / 'upstream'
        upstream.mkdir()
        subprocess.run([real_git, 'init', '-q', str(upstream)], check=True)
        subprocess.run([real_git, '-C', str(upstream), 'config', 'user.name', 'Test'], check=True)
        subprocess.run([real_git, '-C', str(upstream), 'config', 'user.email', 'test@example.test'], check=True)
        (upstream / 'lib.rs').write_text('pub fn f(x: u32) {}\n')
        subprocess.run([real_git, '-C', str(upstream), 'add', '.'], check=True)
        subprocess.run([real_git, '-C', str(upstream), 'commit', '-qm', 'source'], check=True)
        git('-c', 'protocol.file.allow=always', 'submodule', 'add', str(upstream), 'upstream')
        git('add', '.gitmodules', 'upstream')
        manifest.write_text(manifest.read_text() + '\n[lib]\npath="upstream/lib.rs"\n')
        env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='protocol.file.allow', GIT_CONFIG_VALUE_0='always')
        git('add', 'Proofs.lean', 'lean-toolchain', 'lakefile.toml', 'lake-manifest.json')
        commit_push()
        assert 'Use cargo proofs run -- lake build' in cli('run', '--', 'cargo', 'aeneas', ok=False)
        original_git_config = (work / '.git/config').read_bytes()
        original_worktrees = git('worktree', 'list', '--porcelain')
        def assert_snapshot_cleaned():
            assert (work / '.git/config').read_bytes() == original_git_config
            assert git('worktree', 'list', '--porcelain') == original_worktrees
            assert not [p for p in (root / 'real-tmp').iterdir() if p.name != 'xcrun_db']
        env['TEST_LAKE_FAIL'] = '1'
        assert 'Lake build failed' in cli('run', '--', 'lake', 'build', ok=False, case='failed-aeneas-build')
        assert_snapshot_cleaned()
        del env['TEST_LAKE_FAIL']
        env['TEST_LEAN_FAIL'] = '1'
        assert 'sorryAx' in cli('run', '--', 'lake', 'build', ok=False, case='failed-aeneas-audit')
        assert_snapshot_cleaned()
        del env['TEST_LEAN_FAIL']
        cli('run', '--', 'lake', 'build', case='aeneas-manual')
        assert_snapshot_cleaned()
        env['TEST_WIRE_MISMATCH'] = '1'
        mismatch = cli('run', '--', 'lake', 'build', ok=False, case='failed-recording-contract')
        assert 'Server-side changes are required' in mismatch
        assert 'Saved diagnostic ' in mismatch
        del env['TEST_WIRE_MISMATCH']
        assert_snapshot_cleaned()
        cli('publish', '--dry-run')
        cli('publish')
        assert reports[3]['tool_version_id'] == 'aeneas-version'
        assert len(reports[3]['claims']) == 1
        claim = reports[3]['claims'][0]
        assert claim['precondition'] == 'x > 0'
        assert claim['evidence_ref']['harness'] == 'fixture.f_spec'
        assert '/Proofs.lean#L2-L2' in claim['evidence_url']
        config.write_text(config.read_text().replace("x > 0", "x > 1"))
        assert 'Aeneas proof mappings changed' in cli('publish', ok=False)
        config.write_text(config.read_text().replace("x > 1", "x > 0"))
        assert 'No changes' in cli('publish')
        # End-to-end wire cases: all bytes come from production record::run.
        # Restore the root library path; keep the earlier submodule pinned unchanged.
        manifest.write_text(manifest.read_text().replace('upstream/lib.rs','src/lib.rs'))
        def lean_entries(theorems, program=None):
            entries=[{'version':1,'theorem':theorem,'module':'Proofs','statement':'True',
                      'binders':[],'conclusion':'True','program':program,'program_head':program,
                      'axioms':[],'first_line':2,'last_line':2,'definitions':[],
                      'definitions_truncated':False,'translation_rerun':False} for theorem in theorems]
            (work/'contract-lean.json').write_text(json.dumps(entries))
            (work/'Proofs.lean').write_text('namespace fixture\n'+'\n'.join('theorem '+t.split('.')[-1]+' : True := by trivial' for t in theorems)+'\nend fixture\n')
            git('add','contract-lean.json','Proofs.lean')
        def manual_config(mode, apis):
            config.write_text('[report]\ntitle="Wire contract fixture"\n[tool]\nname="aeneas"\nversion="'+'a'*40+'"\n'+mode+'\n'+''.join('[[tool.proofs]]\napi='+json.dumps(api)+'\nmodule="Proofs"\ntheorem="fixture.p'+str(i)+'"\nprecondition="true"\n' for i,api in enumerate(apis)))
            lean_entries(['fixture.p'+str(i) for i in range(len(apis))])
        (work/'src/lib.rs').write_text('#[derive(Clone)] pub struct Table<const L:usize>;\npub struct Crc<W,I>(W,I);\nimpl Crc<u8,Table<0>> { pub fn checksum(&self)->u8 {0} }\n')
        manual_config('concrete_api=true',['Crc<u8, Table<0>>::checksum','Table<0>::clone_from'])
        commit_push(); cli('run','--','lake','build',case='aeneas-concrete')
        cli('publish','--dry-run')
        (work/'src/lib.rs').write_text('macro_rules! api { () => { pub fn f() {} } }\napi!();\n')
        manual_config('expand_api=true',['f'])
        commit_push(); cli('run','--','lake','build',case='aeneas-expanded')
        cli('publish','--dry-run')
        (work/'src/lib.rs').write_text('pub fn f() {}\n')
        manual_config('', ['f','f'])
        commit_push(); cli('run','--','lake','build',case='aeneas-many-theorems')
        cli('publish','--dry-run')
        manual_config('', ['f']*200)
        commit_push();cli('run','--','lake','build',case='aeneas-claim-limit')
        cli('publish','--dry-run')
        manual_config('', ['f']*201)
        commit_push()
        assert 'At most 200' in cli('run','--','lake','build',ok=False)
        config.write_text('[report]\ntitle="Manifest wire fixture"\n[tool]\nname="aeneas"\nversion="'+'a'*40+'"\nproof_modules=["Proofs"]\ntranslation_manifest="translation.json"\n')
        lean_entries(['fixture.manifest_spec'],'fixture.f')
        (work/'Generated.lean').write_text('def fixture.f : Unit := ()\n')
        (work/'translation.json').write_text(json.dumps({'crate':'fixture','aeneas_version':'synthetic','charon_version':'synthetic','functions':[{'def_id':19,'lean_name':'fixture.f','rust_name':'fixture::f','lean_file':'Generated.lean','is_local':True,'source':{'file':'src/lib.rs','begin_line':1,'end_line':1}}]}))
        git('add','Generated.lean','translation.json')
        commit_push(); cli('run','--','lake','build',case='aeneas-manifest')
        cli('publish','--dry-run')
        valid_translation=(work/'translation.json').read_text()
        invalid_translation=json.loads(valid_translation);del invalid_translation['functions'][0]['def_id']
        (work/'translation.json').write_text(json.dumps(invalid_translation))
        git('add','translation.json');commit_push()
        assert 'def_id' in cli('run','--','lake','build',ok=False,case='failed-aeneas-manifest')
        (work/'translation.json').write_text(valid_translation)
        git('add','translation.json')
        # Exercise toolchain provenance serialization with a tiny local Git source.
        # No real tool is built here; the verifier remains explicitly synthetic.
        tool_repo=root/'contract-aeneas'
        (tool_repo/'backends/lean').mkdir(parents=True)
        (tool_repo/'charon-pin').write_text('b'*40+'\n')
        (tool_repo/'backends/lean/lean-toolchain').write_text('leanprover/lean4:v4.35.0\n')
        (tool_repo/'backends/lean/lakefile.lean').write_text('package aeneas\n')
        (tool_repo/'backends/lean/Aeneas.lean').write_text('def contract_original := 0\n')
        for args in [('init','-q'),('config','user.name','Test'),('config','user.email','test@example.test'),('add','.'),('commit','-qm','Synthetic source')]:
            subprocess.run([real_git,'-C',str(tool_repo),*args],check=True,capture_output=True)
        contract_aeneas_version=subprocess.check_output([real_git,'-C',str(tool_repo),'rev-parse','HEAD'],text=True).strip()
        (tool_repo/'backends/lean/Aeneas.lean').write_text('def contract_original := 0\ndef contract_patch := 1\n')
        patch_bytes=subprocess.check_output([real_git,'-C',str(tool_repo),'diff','--binary','--full-index','HEAD','--'])
        (work/'aeneas-contract.patch').write_bytes(patch_bytes)
        subprocess.run([real_git,'-C',str(tool_repo),'checkout','--','.'],check=True)
        env.update(GIT_CONFIG_COUNT='2',GIT_CONFIG_KEY_1='url.'+str(tool_repo)+'.insteadOf',GIT_CONFIG_VALUE_1='https://github.com/AeneasVerif/aeneas')
        (work/'.gitignore').write_text((work/'.gitignore').read_text()+'/.proofs-toolchain/\n')
        manual_config('patch="aeneas-contract.patch"',['f'])
        config.write_text(config.read_text().replace('a'*40,contract_aeneas_version))
        (work/'lake-manifest.json').write_text(json.dumps({'packages':[{'name':'aeneas','type':'path','dir':'.proofs-toolchain/aeneas/backends/lean'}]}))
        git('add','aeneas-contract.patch','lake-manifest.json')
        commit_push();cli('run','--','lake','build',case='aeneas-toolchain')
        cli('publish','--dry-run')
        config.write_text('[report]\ntitle="Structural wire fixture"\n[tool]\nname="kani"\nversion="0.66.0"\n')
        (work/'src/lib.rs').write_text('pub trait Read { fn read(&self); }\nimpl Read for [u8;32] { fn read(&self) {} }\n#[cfg(kani)]\n#[kani::proof_for_contract(<[u8;32] as Read>::read)]\nfn check_read() {}\n')
        commit_push(); cli('run','--','cargo','kani',case='kani-structural')
        cli('publish','--dry-run')
        (work/'src/lib.rs').write_text('use std::fmt::Display;\npub struct S;\nimpl Display for S { fn fmt(&self, _: &mut std::fmt::Formatter) -> std::fmt::Result { Ok(()) } }\n#[cfg(kani)]\n#[kani::proof_for_contract(<S as Display>::fmt)]\nfn check_display() {}\n')
        commit_push(); cli('run','--','cargo','kani',case='kani-aliases')
        cli('publish','--dry-run')
        (work/'src/lib.rs').write_text(source)
        (work/'dep/src').mkdir(parents=True)
        (work/'dep/Cargo.toml').write_text('[package]\nname="contract-dep"\nversion="0.1.0"\nedition="2021"\n')
        (work/'dep/src/lib.rs').write_text('pub fn dependency() {}\n')
        manifest.write_text(manifest.read_text()+'\n[dependencies]\ncontract-dep={path="dep"}\n')
        git('add','dep')
        commit_push(); cli('run','--','cargo','kani',case='kani-dependency')
        cli('publish','--dry-run')
        capture.finish()
        cli('logout')
        assert 'Not logged in' in cli('publish', ok=False)
        print('End-to-end: login, SARIF-only recording, published source, dry-run, create, no-op, conflict, force, removal, restore, retry, Creusot targets/claims/evidence, Aeneas Lean recording/failures/mappings, logout passed')
    finally:
        server.shutdown()
        thread.join()

