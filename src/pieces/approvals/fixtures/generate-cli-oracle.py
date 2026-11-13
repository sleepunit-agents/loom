import os, tempfile, json, types, contextlib, io, sys
from pathlib import Path
from datetime import datetime, timezone
for k in ('LOOM_PIECE_HOME','HOUSE_ID','LOOM_BODY_CONVERSATION','LOOM_BODY_KEY','APPROVALS_SEED_RULES'):
    os.environ.pop(k,None)
script=Path(sys.argv[1])  # bin/approvals from upstream 588b3f7c22f86068063153676de159597348216a
with tempfile.TemporaryDirectory() as root:
    os.environ['APPROVALS_DIR']=root
    ap=types.ModuleType('approvals_oracle');ap.__file__=str(script)
    exec(compile(script.read_text(),str(script),'exec'),ap.__dict__)
    ap.now=lambda:datetime(2026,11,12,0,0,tzinfo=timezone.utc)
    ap.secrets.token_hex=lambda n:'01234567'
    ap.principal_for_call=lambda *args,**kwargs:{'for':'owner','people':[]}
    ap.projects=lambda:[]
    ap.LOCAL_AGENT='art'
    target='github:acme/app#12@'+'a'*40
    receipt={'id':'a-01234567','kind':'merge','target':target,'what':'Merge the fix?','why':'It fixes the page.','who':{'agent':'art','where':'h-1'},'for':'owner','minutes':60,'at':'2026-11-12T00:00:00Z','state':'pending','ask':'Merge the fix?','if_yes':'I merge it.','if_no':'I leave it open.'}
    allowed={**receipt,'state':'allowed','decided':'2026-11-12T00:00:00Z','expires':'2026-11-12T01:00:00Z','by':'jonathan'}
    cases=[]
    def case(label,argv,approvals=[],rules=[],member=False,principal=None):
        principal = principal or {'for':'owner','people':[]}
        ap.principal_for_call=lambda *args,**kwargs:principal
        with tempfile.TemporaryDirectory(dir=root) as home:
            ap.STATE=Path(home)
            Path(home,'approvals.json').write_text(json.dumps({'v':1,'approvals':{a['id']:a for a in approvals},'notices':[]}))
            Path(home,'rules.json').write_text(json.dumps({'v':1,'rules':rules,'grants':[],'standing':[]}))
            try:
                with contextlib.redirect_stderr(io.StringIO()):
                    out=ap.run(argv,None if member else {'kind':'agent','agent':'art','house':'h-1'})
                out,err=out if isinstance(out,tuple) else (out,'')
                expected={'exit':0,'stdout':out,'stderr':err}
            except (ValueError,LookupError,PermissionError) as e:
                expected={'exit':1,'stdout':'','stderr':f'approvals: {e}\n'}
            cases.append({'label':label,'argv':argv,'approvals':approvals,'rules':rules,'member':member,'principal':principal,'expected':expected})
    case('request',['request','--kind','merge','--target',target,'--ask','Merge the fix?','--why','It fixes the page.','--if-yes','I merge it.','--if-no','I leave it open.'])
    case('request already allowed',['request','--kind','merge','--target',target,'--what','Merge the fix?','--why','It fixes the page.'],[allowed])
    for state,a in [('pending',receipt),('allowed',allowed),('denied',{**receipt,'state':'denied','decided':receipt['at']})]:
        case('check '+state,['check',a['id']],[a])
        case('check json '+state,['check',a['id'],'--json','--principal','fixture-proof'],[a])
    case('use',['use',receipt['id'],'--kind','merge','--target',target],[allowed])
    case('use pending',['use',receipt['id'],'--kind','merge','--target',target],[receipt])
    case('use wrong kind',['use',receipt['id'],'--kind','relay','--target',target],[allowed])
    case('use wrong target',['use',receipt['id'],'--kind','merge','--target',target+'b'],[allowed])
    case('standing refused',['standing','--check','s-01234567'])
    case('withdraw',['withdraw',receipt['id']],[receipt])
    case('rule asks',['rule','merge',target])
    case('rule json',['rule','merge',target,'--json'])
    case('rule pending',['rule','merge',target],[receipt])
    case('rule allowed',['rule','merge',target],[allowed])
    do={'kind':'merge','scope':'github:acme/*','tier':'do','by':'jonathan','at':receipt['at']}
    case('rule do',['rule','merge',target],rules=[do])
    case('owner rule for agent',['rule','merge',target,'--for','art','--json'],rules=[do],member=True)
    case('owner rule asked for',['rule','merge',target,'--for','art','--json'],[{**receipt,'for':'loren'},{**allowed,'id':'a-89abcdef','for':'dan'}],rules=[do],member=True)
    case('tell',['tell','--kind','merge','--target',target,'--what','Fixed the page.'],rules=[do])
    case('owner list',['list'],[allowed],member=True)
    case('owner grant',['grant','--kind','merge','--target',target,'--for','art'],member=True)
    case('agent list refused',['list'],[receipt])
    case('agent grant refused',['grant','--kind','merge','--target',target,'--for','art'])
    # Authenticated principal comes from a trusted fixture, never from CLI flags.
    for principal in [{'for':'loren','people':[]},{'for':'?','people':[]},{'for':'?','people':['dan','eve']},{'for':'?','people':['dan','eve','loren']},{'for':'?','people':['dan','eve','loren','mark']}]:
        label='principal '+principal['for']+':'+','.join(principal['people'])
        own={**allowed,'for':principal['for'],'people':principal['people']}
        case(label+' spends matching receipt',['use',own['id'],'--kind','merge','--target',target],[own],principal=principal)
        case(label+' cannot spend owner receipt',['use',allowed['id'],'--kind','merge','--target',target],[allowed],principal=principal)
        case(label+' rule',['rule','merge',target,'--json'],[own],rules=[do],principal=principal)
        case(label+' check json',['check',own['id'],'--json','--principal=fixture-proof'],[own],principal=principal)
    case('unknown people mismatch',['use',allowed['id'],'--kind','merge','--target',target],[{**allowed,'for':'?','people':['eve']}],principal={'for':'?','people':['dan']})
    case('equals values',['use',allowed['id'],'--kind=merge','--target='+target],[allowed])
    case('last repeated value wins',['use',allowed['id'],'--kind','relay','--kind','merge','--target',target],[allowed])
    case('flags before positional',['check','--json',allowed['id']],[allowed])
    for label,argv in [
        ('no command',[]),('unknown command',['wat']),
        ('check missing id',['check']),('use missing id',['use']),('withdraw missing id',['withdraw']),
        ('rule missing kind',['rule']),('rule missing targets',['rule','merge']),
        ('check extra id',['check',allowed['id'],'extra']),
        ('unknown flag',['check',allowed['id'],'--bogus']),
        ('value missing',['request','--kind']),('value followed by flag',['request','--kind','--why','reason']),
        ('boolean with value',['check',allowed['id'],'--json=yes']),
    ]:
        case('invalid '+label,argv)
    dest=Path(__file__).resolve().parent
    Path(dest,'cli-oracle.json').write_text(json.dumps({'upstream':'588b3f7c22f86068063153676de159597348216a','generated_by':'offline Python run() oracle; frozen time and id; trusted principal fixtures; no runtime subprocess','cases':cases},indent=2)+'\n')
