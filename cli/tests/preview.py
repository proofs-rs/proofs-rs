"""Exercise the packaged preview without service writes, a checkout, or npm installs."""
import copy
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

binary = str(Path(sys.argv[1]).resolve())
requests = []
missing = False
ambiguous = False
remote = {'id': 8, 'crate':'fixture','version':'1.0.0','title':'Web title','revision_no':3,'author_id':'author','withdrawn_at':None,'explanation':'Web overview','trusted_assumptions':'','limitations':'','environment':'','dependencies':[],'claims':[{'id':'permanent','api_item_id':'api-f','title':'Web claim title','explanation':'Web claim text','precondition':'old','evidence_url':'https://example.com/old'},{'id':'removed','api_item_id':'api-g','title':'Removed claim'}]}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, status, data):
        self.send_response(status); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps(data).encode())
    def do_GET(self):
        requests.append(('GET',self.path))
        if self.path == '/api/v1/me':
            assert self.headers.get('Authorization') == 'Bearer fixture-token'
            return self.reply(200,{'user':{'id':'author'}})
        assert self.headers.get('Authorization') is None, 'Credentials must only be used for identity lookup'
        if missing: return self.reply(404,{'error':'missing'})
        if self.path == '/api/v1/tools': return self.reply(200,{'items':[{'id':'kani','name':'Kani','active':True}],'versions':[{'id':'kani-1','tool_id':'kani','version':'1','selectable':True}]})
        if self.path == '/api/v1/tool-versions/kani-1': return self.reply(200,{'tool':'Kani','version':'1','limitations':'Tool limitations'})
        if self.path == '/api/v1/crates/fixture/1.0.0/apis': return self.reply(200,{'items':[{'id':'api-f','display_path':'fixture::f','signature':'pub fn f()','kind':'function','is_unsafe':0}]})
        if self.path.startswith('/api/v1/resolve-api?'):
            if ambiguous and 'alias' in self.path: return self.reply(200,{'id':'api-other'})
            return self.reply(200,{'id':'api-f'})
        if self.path == '/api/v1/reports/8': return self.reply(200,remote)
        return self.reply(404,{'error':'report_not_found'})
    def do_POST(self):
        requests.append(('POST',self.path)); self.reply(500,{'error':'forbidden_write'})
    do_PUT=do_POST
    do_DELETE=do_POST
    do_PATCH=do_POST

service=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=service.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{service.server_port}'

def digest(value): return hashlib.sha256(str(value).encode()).hexdigest()
def fetch(url, method='GET', headers=None):
    try:
        with urlopen(Request(url,method=method,headers=headers or {}),timeout=15) as r: return r.status,r.read().decode(),r.headers
    except HTTPError as e: return e.code,e.read().decode(),e.headers

def files(root): return {str(p):p.read_bytes() for p in root.rglob('*') if p.is_file()}

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp).resolve(); work=root/'project'; (work/'src').mkdir(parents=True)
    (work/'Cargo.toml').write_text('[package]\nname="fixture"\nversion="1.0.0"\nedition="2021"\n')
    (work/'src/lib.rs').write_text('pub fn f() {}\n')
    config=work/'proofs.toml'
    original='[report]\ntitle="Preview report"\n[tool]\nname="kani"\nversion="1"\n'
    config.write_text(original)
    env=dict(os.environ,PROOFS_CONFIG_DIR=str(root/'credentials'),XDG_DATA_HOME=str(root/'data'))
    # dirs uses the OS data directory on macOS; only this unique fixture directory is touched.
    data_base=Path.home()/'Library/Application Support' if sys.platform=='darwin' else root/'data'
    state=data_base/'cargo-proofs'/digest(work/'Cargo.toml')
    run='11111111-1111-4111-8111-111111111111'
    record=state/'runs'/run; record.mkdir(parents=True)
    sarif={'version':'2.1.0','runs':[{'automationDetails':{'guid':run},'tool':{'driver':{'name':'kani','version':'1'}},'invocations':[{'executionSuccessful':True,'exitCode':0,'executableLocation':{'uri':'cargo'},'arguments':['kani'],'workingDirectory':{'uri':'./'},'startTimeUtc':'2026-10-18T00:00:00Z','endTimeUtc':'2026-10-18T00:00:01Z','stdout':{'index':0}}],'artifacts':[{'contents':{'text':'Local log <script>unsafe</script>'}}],'versionControlProvenance':[{'repositoryUri':'https://github.com/fixture/source','revisionId':'a'*40}],'properties':{'proofs':{'schemaVersion':2,'dependencies':[],'crate':'fixture','version':'1.0.0','target':None,'contracts':[{'api_paths':['fixture::f','fixture::alias'],'precondition':'x > 0','file':'src/lib.rs','first_line':1,'last_line':1,'harness':'check_f'}]}},'results':[{'kind':'pass','message':{'text':'Verified'},'properties':{'harness':'check_f'}}]}]}
    (record/'run.sarif.json').write_text(json.dumps(sarif)); (state/'latest.json').write_text(json.dumps(run))
    procs=[]
    def start(*args, custom_env=None):
        p=subprocess.Popen([binary,'--server',origin,'preview','--manifest-path',str(work/'Cargo.toml'),'--no-browser',*args],cwd=root,env=custom_env or env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        procs.append(p); q=queue.Queue()
        def read():
            for line in p.stdout: q.put(line)
            q.put(None)
        threading.Thread(target=read,daemon=True).start()
        deadline=time.monotonic()+25
        while time.monotonic()<deadline:
            line=q.get(timeout=max(.1,deadline-time.monotonic()))
            if line is None: raise AssertionError(p.stderr.read())
            match=re.search(r'http://127\.0\.0\.1:\d+/report',line)
            if match: return p,match[0]
        raise AssertionError('Preview did not start')
    def node_child(p):
        listing=subprocess.check_output(['ps','-ax','-o','pid=,ppid=,command='],text=True)
        for line in listing.splitlines():
            fields=line.strip().split(None,2)
            if len(fields)==3 and fields[1]==str(p.pid) and 'server.cjs' in fields[2]:
                command=fields[2].split()
                script=next(Path(arg) for arg in command if arg.endswith('server.cjs'))
                return int(fields[0]),script
        raise AssertionError('Missing Node child')
    def stop(p):
        p.send_signal(signal.SIGINT); assert p.wait(timeout=8)==0,p.stderr.read()
    def failure(*args, custom_env=None):
        p=subprocess.run([binary,'--server',origin,'preview','--manifest-path',str(work/'Cargo.toml'),'--no-browser',*args],cwd=root,env=custom_env or env,text=True,capture_output=True,timeout=25)
        assert p.returncode!=0
        return p.stderr
    try:
        before=files(state)
        p,url=start()
        status,html,headers=fetch(url)
        assert status==200 and 'New report' in html and 'Preview report' in html
        assert 'Web claim text' not in html and 'Local preview — not published' in html
        assert 'no-store' in headers['Cache-Control'] and "frame-ancestors 'none'" in headers['Content-Security-Policy']
        assert fetch(url,'HEAD')[1]==''
        assert fetch(url,'POST')[0]==405
        assert fetch(url,headers={'Host':'evil.example'})[0]==403
        assert fetch(url,headers={'Origin':'https://evil.example'})[0]==403
        base=url.removesuffix('/report')
        assert fetch(base+'/etc/passwd')[0]==404
        assert fetch(base+'/theme-a.css')[0]==200
        assert 'x &gt; 0' in fetch(base+'/claim/preview-claim-0')[1]
        assert 'Local log &lt;script&gt;' in fetch(base+'/runs/'+run)[1]
        assert json.loads(fetch(base+'/api/v1/runs/'+run+'/sarif')[1])==sarif
        assert files(state)==before
        config.write_text(original.replace('Preview report','Edited title'))
        assert 'Edited title' in fetch(url)[1]
        config.write_text('not valid toml =')
        assert fetch(url)[0]==500
        config.write_text(original)
        assert fetch(url)[0]==200
        # Latest changes do not change the selected run in a running preview.
        (state/'latest.json').write_text(json.dumps('22222222-2222-4222-8222-222222222222'))
        assert fetch(url)[0]==200
        (state/'latest.json').write_text(json.dumps(run))
        missing=True
        assert 'API mapping and signature unverified' in fetch(url)[1]
        assert 'API unverified' in fetch(base+'/claim/preview-claim-0')[1]
        missing=False; ambiguous=True
        # Exact catalogue aliases resolve deterministically without generic erasure.
        assert 'API mapping and signature unverified' not in fetch(url)[1]
        ambiguous=False
        # A competing server cannot silently choose a new port.
        assert 'EADDRINUSE' in failure('--port',url.split(':')[2].split('/')[0])
        child_pid,script=node_child(p)
        assert script.is_file()
        stop(p)
        assert not script.exists(), 'Temporary bundle was not cleaned up'
        with socket.socket() as s: assert s.connect_ex(('127.0.0.1',int(url.split(':')[2].split('/')[0])))!=0
        p,url=start('--report','8')
        html=fetch(url)[1]
        assert 'Draft revision of report #8' in html and 'Web overview' in html
        assert 'Web claim text' in fetch(url.removesuffix('/report')+'/claim/permanent')[1]
        assert '1 existing claim(s)' in html
        stop(p)
        p,url=start()
        child_pid,script=node_child(p)
        os.kill(child_pid,signal.SIGTERM)
        assert p.wait(timeout=8)!=0
        assert 'exited unexpectedly' in p.stderr.read()
        assert not script.exists()
        assert 'report_not_found' in failure('--report','99')
        remote['version']='2.0.0'
        assert 'different crate/version' in failure('--report','8')
        remote['version']='1.0.0'
        credentials=root/'credentials'; credentials.mkdir()
        (credentials/(digest(origin)+'.json')).write_text(json.dumps({'access_token':'fixture-token','expires_at':int(time.time())+3600}))
        publication=state/'publication'; publication.mkdir()
        saved={'report_id':8,'revision':2,'snapshot':remote,'known_claims':{},'pending':{'path':'/api/v1/reports/8/revisions','body':{'title':'Pending'},'key':'pending-key'}}
        (publication/(digest(f'{origin}\nauthor\n{work / "Cargo.toml"}\nfixture\n1.0.0')+'.json')).write_text(json.dumps(saved))
        before=files(state); creds_before=files(credentials)
        p,url=start()
        html=fetch(url)[1]
        assert 'Draft revision of report #8' in html and 'server revision changed' in html and 'interrupted publication' in html
        remote['withdrawn_at']='2026-10-18'
        assert 'withdrawn and cannot be revised' in fetch(url)[1]
        stop(p)
        assert files(state)==before and files(credentials)==creds_before
        # Node detection precedes Cargo and service access.
        wrapper=root/'bin'; wrapper.mkdir(); node=wrapper/'node'
        node.write_text('#!/bin/sh\necho v22.0.0\n'); node.chmod(0o755)
        assert 'Node.js 24' in failure(custom_env=dict(env,PATH=str(wrapper)))
        node.unlink()
        assert 'Node.js 24' in failure(custom_env=dict(env,PATH=str(wrapper)))
        (record/'run.sarif.json').write_text(json.dumps({**sarif, 'runs':[{**sarif['runs'][0], 'invocations':[{**sarif['runs'][0]['invocations'][0], 'executionSuccessful':False}]}]}))
        assert 'did not produce publishable' in failure()
        (record/'run.sarif.json').write_text(json.dumps(sarif))
        config.write_text(original.replace('version="1"','version="2"'))
        assert 'Tool configuration changed' in failure()
        config.write_text(original)
        assert 'Recorded run not found' in failure('--run','22222222-2222-4222-8222-222222222222')
        assert all(method=='GET' for method,_ in requests),requests
        assert not any(any(x in path for x in ['/prepare','/validate','/sarif']) for _,path in requests)
        print('Preview E2E: read-only requests, new/revised reports, reload recovery, missing metadata, run pinning, HTTP boundaries and shutdown passed.')
    finally:
        for p in procs:
            if p.poll() is None: p.kill(); p.wait()
        shutil.rmtree(state)
        service.shutdown()

subprocess.run([sys.executable, str(Path(__file__).with_name('preview_draft.py')), binary], check=True)
