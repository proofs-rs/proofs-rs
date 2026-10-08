"""Generate additive, repeatable staging fixtures; never a schema migration."""
import json, uuid
from pathlib import Path
D=json.loads(Path('fixtures/staging-demo.json').read_text())
Q=[]
def val(x):
    if x is None:return 'NULL'
    if isinstance(x,int):return str(x)
    return "'"+str(x).replace("'","''").replace("\n", "'||char(10)||'")+"'"
def insert(table, **values):
    Q.append('INSERT OR IGNORE INTO '+table+'('+','.join(values)+') VALUES('+','.join(v[1] if isinstance(v,tuple) else val(v) for v in values.values())+');')
def expr(s):return ('sql',s)
def uid(s):return str(uuid.uuid5(uuid.NAMESPACE_URL,'https://proofs.rs/staging-demo/v1/'+s))
def date(n):return f'2026-09-{min(28,10+n):02d}T10:00:00.000Z'
def rel(c):return expr("(SELECT r.id FROM releases r JOIN crates c ON c.id=r.crate_id WHERE c.name="+val(c['name'])+" AND r.version="+val(c['v']+'-demo.1')+")")
for i,name in enumerate(['mira','nora','emil','soren']):
    insert('users',id=uid(name),github_id=-91001-i,username='demo_'+name,role='user',status='active',accepted_terms_version='2026-09-21',terms_accepted_at=date(0),created_at=date(0))
    insert('notification_preferences',user_id=uid(name),replies=0,report_comments=0)
for t in D['tools']:
    insert('tools',id='demo-'+t['id'],name=t['name']+' (demo)',description=t['description']+' Staging fixture; versions are illustrative.',official_url=t['url'])
    for v in t['versions']:insert('tool_versions',id=uid(t['id']+v),tool_id='demo-'+t['id'],version=v)
for c in D['crates']:
    insert('crates',name=c['name'],description=c['desc'])
    insert('releases',crate_id=expr('(SELECT id FROM crates WHERE name='+val(c['name'])+')'),version=c['v']+'-demo.1',created_at=date(0))
    # Deliberately no doc_snapshots: dummy APIs must not masquerade as an imported catalog.
    for a in c['apis']:
        unsafe='unchecked' in a
        insert('api_items',id=uid(c['name']+'/'+a),release_id=rel(c),canonical_key='demo:'+a,display_path=a if a.startswith('<') else c['name'].replace('-','_')+'::'+a,kind='method' if '::' in a else 'function',is_unsafe=int(unsafe),signature=c.get('signatures',{}).get(a,('pub unsafe fn ' if unsafe else 'pub fn ')+a.split('::')[-1]+'(/* demo signature */)'),upstream_url='https://docs.rs/'+c['name']+'/'+c['v'])
claims=D['claims']+[dict(D['claims'][1],id=104,title='',comments=[],revision=1,description='')]
groups={}
for c in claims:groups.setdefault((c['crate'],c['method'].split(' · ')[0]),[]).append(c)
def rid(key):return expr("(SELECT id FROM reports WHERE create_key="+val('staging-demo-reports-v1-'+key[0]+'-'+key[1])+")")
for index,(key,items) in enumerate(groups.items()):
    crate=next(c for c in D['crates'] if c['name']==key[0])
    t=next(t for t in D['tools'] if t['name']==key[1])
    author=items[0]['author']; rev=max(c['revision'] for c in items)
    created=date(15) if key[0]=='trait-demo' else date(index)
    insert('reports',create_key='staging-demo-reports-v1-'+key[0]+'-'+key[1],release_id=rel(crate),author_id=uid(author),withdrawn_at=date(10) if items[0]['id']==35 else None,created_at=created,updated_at=date(10) if rev>1 else created)
    for c in items:
        insert('claims',id=uid('claim/'+str(c['id'])),report_id=rid(key),api_item_id=uid(c['crate']+'/'+c['api']),property='no_ub' if c['property']=='No undefined behavior' else 'panic_contract',created_at=created)
    for revision in range(1,rev+1):
        insert('report_revisions',report_id=rid(key),revision_no=revision,title=key[0]+' verification with '+key[1]+(' — initial scope' if revision<rev else ''),explanation='Synthetic staging report based on the original design examples.',trusted_assumptions='Illustrative tool implementation, compiler and library models.',tool_version_id=uid(t['id']+t['versions'][0]),environment='See each claim for the concrete types, bounds and features.',evidence_url='https://example.com/proofs-rs-demo/reports/'+str(index+1),limitations='Synthetic staging data. No proof was run.',created_at=created if revision==1 else date(10))
        for pos,c in enumerate(items):
            title=c['title'] or c['property']+' for '+c['crate']+'::'+c['api']+' (with '+key[1]+' '+t['versions'][0]+')'
            insert('claim_revisions',claim_id=uid('claim/'+str(c['id'])),report_id=rid(key),report_revision=revision,position=pos,title=title,precondition=c['condition']+'\n'+c['formula'],explanation=c['description'],trusted_assumptions='',evidence_url='' if c['id']==104 else 'https://example.com/proofs-rs-demo/'+str(c['id']),limitations=c['scope'])
    sequence=0
    for c in items:
        for j,cm in enumerate(c['comments']):
            name,_,body,*_=cm;sequence+=1
            parent=uid('comment/'+str(c['id'])+'/'+str(j-1)) if j and (name==c['author'] or c['id']==17 and j==2) else None
            insert('report_comments',id=uid('comment/'+str(c['id'])+'/'+str(j)),report_id=rid(key),sequence_no=sequence,revision_no=1 if j<2 else rev,author_id=uid(name),reply_to_id=parent,body=body,created_at=date(min(10,index+j)))
        for name in ['mira','nora','emil','soren'][:c['id']%4]:
            insert('claim_stars',claim_id=uid('claim/'+str(c['id'])),user_id=uid(name),created_at=date(10))
    for name in ['mira','nora','emil','soren'][:(index%4)+1]:insert('report_stars',report_id=rid(key),user_id=uid(name),created_at=date(10))
    if key==('arrayvec','Kani'):
        insert('report_comments',id=uid('deleted'),report_id=rid(key),sequence_no=sequence+1,revision_no=rev,author_id=uid('soren'),body=None,created_at=date(9),deleted_at=date(10),edit_version=2)
        insert('report_comment_history',comment_id=uid('deleted'),history_no=1,action='delete',body='Demo: an obsolete question removed by its author.',actor_id=uid('soren'),created_at=date(10))
        insert('report_comments',id=uid('deleted-reply'),report_id=rid(key),sequence_no=sequence+2,revision_no=rev,author_id=uid('mira'),reply_to_id=uid('deleted'),body='The parent was removed; this reply remains in the discussion.',created_at=date(10))
    if key==('bytes','Kani'):
        insert('report_comments',id=uid('edited'),report_id=rid(key),sequence_no=sequence+1,revision_no=rev,author_id=uid('nora'),body='Edited: the range endpoint equal to the buffer length is included.',edit_version=2,created_at=date(9),edited_at=date(10))
        insert('report_comment_history',comment_id=uid('edited'),history_no=1,action='edit',body='Is the upper endpoint covered?',actor_id=uid('nora'),created_at=date(10))
        for name in ['emil','soren']:insert('report_comment_votes',comment_id=uid('edited'),user_id=uid(name),value=1,updated_at=date(10))
insert('audit_events',id=uid('reports-seed-audit'),action='staging_demo_seed',target_id='staging-demo-reports-v1',reason='User-requested synthetic staging data based on the original Sites mock.',created_at=date(10))
# Additive fixtures reserved for report-layout review.
import hashlib
c={'name':'report-layout-demo','v':'1.0.0'}
insert('tools',id='layout-demo',name='Layout demo',description='Synthetic tool',official_url='https://example.com/layout-demo')
insert('tool_versions',id=uid('layout/tool'),tool_id='layout-demo',version='1.0',limitations='Synthetic tool limitation for layout review.',limitations_updated_at=date(0))
insert('crates',name=c['name'],description='Synthetic report layout cases; no verification was performed.')
insert('releases',crate_id=expr("(SELECT id FROM crates WHERE name='report-layout-demo')"),version='1.0.0-demo.1',created_at=date(0))
apis=[('decode','function',None,None,0),('decode_with_configuration_and_validate_the_entire_input','function',None,None,1),('Buffer::new','associated',None,'Buffer',0),('Buffer::read','method',None,'Buffer',0),('<Buffer as core::fmt::Display>::fmt','trait','core::fmt::Display','Buffer',0),('<View as core::fmt::Display>::fmt','trait','core::fmt::Display','View',0),('<T as core::convert::Into<T>>::into','trait','core::convert::Into<T>','T',0)]
for name,cat,trait,selftype,unsafe in apis:
    aid=uid('layout/api/'+name)
    insert('api_items',id=aid,release_id=rel(c),canonical_key='layout:'+name,display_path=name if name.startswith('<') else 'report_layout_demo::'+name,kind='function' if cat=='function' else 'method',is_unsafe=unsafe,signature='pub '+('unsafe ' if unsafe else '')+'fn '+name.split('::')[-1]+'(/* synthetic */)',upstream_url='https://example.com/layout-demo')
    insert('api_item_metadata',api_item_id=aid,category=cat,trait_path=trait,self_type=selftype,method_name=name.split('::')[-1],is_blanket=int(selftype=='T'))
for mode in ['full','minimal','environment-only','withdrawn']:
    key='staging-layout-v1-'+mode
    reportid=expr('(SELECT id FROM reports WHERE create_key='+val(key)+')')
    insert('reports',create_key=key,release_id=rel(c),author_id=uid('mira'),withdrawn_at=date(10) if mode=='withdrawn' else None,created_at=date(0),updated_at=date(10))
    entries=[(name,p) for name,*_ in apis for p in ['panic_contract','no_ub']]+[('decode','panic_contract')] if mode=='full' else [('decode','panic_contract')]
    for n,(name,prop) in enumerate(entries):
        insert('claims',id=uid('layout/'+mode+'/'+str(n)),report_id=reportid,api_item_id=uid('layout/api/'+name),property=prop,created_at=date(0))
    for rev in range(1,56 if mode=='full' else 2):
        insert('report_revisions',report_id=reportid,revision_no=rev,title='Layout demo — '+mode,explanation='Synthetic display fixture. No verification was performed.' if mode!='minimal' else '',trusted_assumptions='Synthetic compiler and tool models.' if mode=='full' else '',environment='Synthetic Linux x86_64\nRust demo toolchain\nNo actual verification was run.' if mode in ['full','environment-only'] else '',evidence_url='https://example.com/layout-demo' if mode=='full' else '',limitations='Layout demonstration only.' if mode=='full' else '',tool_version_id=uid('layout/tool'),created_at=date(0))
        for n,(name,prop) in enumerate(entries):
            insert('claim_revisions',claim_id=uid('layout/'+mode+'/'+str(n)),report_id=reportid,report_revision=rev,position=n,title='Synthetic claim '+str(n+1),precondition='Demo input only',explanation='Synthetic claim explanation retained on the detail page.',trusted_assumptions='Synthetic claim trust',evidence_url='https://example.com/layout-demo',limitations='Not a real proof')
    if mode=='full':
        for n in range(55):insert('report_comments',id=uid('layout/comment/'+str(n)),report_id=reportid,sequence_no=n+1,revision_no=55,author_id=uid('nora'),body='Synthetic pagination comment '+str(n+1),created_at=date(0))
        for n in range(2):
            runid=uid('layout/run/'+str(n)); objectkey='staging-layout-v1/'+runid+'.sarif.json'
            sarif={'version':'2.1.0','$schema':'https://json.schemastore.org/sarif-2.1.0.json','runs':[{'automationDetails':{'guid':runid},'tool':{'driver':{'name':'Layout demo','version':'1.0'}},'invocations':[{'executableLocation':{'uri':'echo'},'arguments':['Synthetic fixture; no verification performed'],'workingDirectory':{'uri':'./'},'executionSuccessful':True,'exitCode':0,'startTimeUtc':date(0),'endTimeUtc':date(0),'environmentVariables':{},'stdout':{'index':0}}],'versionControlProvenance':[{'repositoryUri':'https://github.com/proofs-rs/proofs-rs','revisionId':'0'*40}],'properties':{'proofs':{'schemaVersion':2,'dependencies':[],'crate':c['name'],'version':'1.0.0-demo.1','platform':'Synthetic platform','rustc':'Synthetic compiler','contracts':[{'harness':'demo','precondition':'Demo input only','file':'src/lib.rs','first_line':1,'last_line':1,'api_paths':['report_layout_demo::decode'],'properties':['panic_contract','no_ub']}]}},'artifacts':[{'contents':{'text':'Synthetic diagnostics <not HTML>. No verification performed.'}}],'results':[{'kind':'informational','message':{'text':'Synthetic example only'},'properties':{'harness':'demo'}}]}]}
            data=json.dumps(sarif,indent=2)+'\n';Path('fixtures/layout-run-'+str(n)+'.sarif.json').write_text(data)
            insert('verification_runs',id=runid,author_id=uid('mira'),crate=c['name'],version='1.0.0-demo.1',tool_version_id=uid('layout/tool'),sha256=hashlib.sha256(data.encode()).hexdigest(),size=len(data.encode()),r2_key=objectkey,created_at=date(0))
            for rev in [1,55]:insert('report_runs',report_id=reportid,revision_no=rev,run_id=runid,position=n)

Path('fixtures/layout-runs.json').write_text(json.dumps(['staging-layout-v1/'+uid('layout/run/'+str(n))+'.sarif.json' for n in range(2)],indent=2)+'\n')
Path('fixtures/staging-demo.sql').write_text('\n'.join(Q)+'\n')
print(f'{len(groups)} reports; {len(claims)} claims; {len(Q)} additive statements')

# Separate, optional fixture for exercising growing lists on staging.
Q=[]
c={'name':'pagination-demo','v':'1.0.0'}
insert('crates',name=c['name'],description='Synthetic pagination fixture. No verification was performed.')
insert('releases',crate_id=expr("(SELECT id FROM crates WHERE name='pagination-demo')"),version='1.0.0-demo.1',created_at=date(0))
aid=uid('pagination/api')
insert('api_items',id=aid,release_id=rel(c),canonical_key='pagination:decode',display_path='pagination_demo::decode',kind='function',is_unsafe=0,signature='pub fn decode(/* synthetic */)',upstream_url='https://example.com/pagination-demo')
insert('api_item_metadata',api_item_id=aid,category='function',method_name='decode',is_blanket=0)
for n in range(36):
    key='staging-pagination-v1-'+str(n)
    reportid=expr('(SELECT id FROM reports WHERE create_key='+val(key)+')')
    claimid=uid('pagination/claim/'+str(n))
    insert('reports',create_key=key,release_id=rel(c),author_id=uid('mira'),created_at=date(0),updated_at=date(0))
    insert('report_revisions',report_id=reportid,revision_no=1,title='Pagination demo '+str(n+1).zfill(2),explanation='Synthetic pagination fixture. No verification was performed.',trusted_assumptions='',environment='Synthetic fixture',evidence_url='https://example.com/pagination-demo',limitations='Not a real proof.',tool_version_id=uid('layout/tool'),created_at=date(0))
    insert('claims',id=claimid,report_id=reportid,api_item_id=aid,property='panic_contract',created_at=date(0))
    insert('claim_revisions',claim_id=claimid,report_id=reportid,report_revision=1,position=0,title='Synthetic pagination claim '+str(n+1),precondition='Synthetic input only',explanation='Pagination demonstration only.',trusted_assumptions='',evidence_url='https://example.com/pagination-demo',limitations='Not a real proof.')
Path('fixtures/staging-pagination.sql').write_text('\n'.join(Q)+'\n')
