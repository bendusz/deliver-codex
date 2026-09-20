import concurrent.futures,datetime,hashlib,json,os,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=Path(__file__).resolve().parent
cli=root/'plugins/deliver/skills/deliver/scripts/claude-review.mjs'
def run(name):
 packet=out/f'packet-{name}.json';receipt=out/f'{name}.receipt.json'
 args=['node',str(cli),'--input',str(packet),'--out',str(receipt),'--model','claude-fable-5-1','--timeout-seconds','900','--allow-external']
 meta={'model':'claude-fable-5-1','effort':'high','effort_environment':{'CLAUDE_CODE_EFFORT_LEVEL':'high'},'argv':args,'packet_sha256':hashlib.sha256(packet.read_bytes()).hexdigest(),'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'attempt':1}
 (out/f'{name}.invocation.json').write_text(json.dumps(meta,indent=2)+'\n')
 env=os.environ.copy();env['CLAUDE_CODE_EFFORT_LEVEL']='high'
 with (out/f'{name}.adapter.log').open('wb') as log: result=subprocess.run(args,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
 meta.update(exit_code=result.returncode,finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),log_sha256=hashlib.sha256((out/f'{name}.adapter.log').read_bytes()).hexdigest())
 if receipt.exists():meta['receipt_sha256']=hashlib.sha256(receipt.read_bytes()).hexdigest()
 (out/f'{name}.invocation.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps({'packet':name,**meta}),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(run,['provider-source','artifact-repair']))
