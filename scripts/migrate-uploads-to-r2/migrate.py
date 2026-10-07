#!/usr/bin/env python3
"""Explicit CLI migration. Stable content-derived private keys and replay-safe updates."""
import argparse, hashlib, json, pathlib, sqlite3, subprocess
p=argparse.ArgumentParser();p.add_argument('snapshot',type=pathlib.Path);p.add_argument('data_dir',type=pathlib.Path);p.add_argument('--out',type=pathlib.Path,default=pathlib.Path('.migration/uploads'));p.add_argument('--bucket',default='mediaciones-files');p.add_argument('--remote',action='store_true');p.add_argument('--include-users',action='store_true',help='Only when matching accounts were explicitly migrated');p.add_argument('--include-exports',action='store_true',help='Only when matching historical export metadata was migrated');p.add_argument('--persist-to',type=pathlib.Path,help='Local isolated Wrangler storage for verification');p.add_argument('--apply',action='store_true');a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True);__import__('os').chmod(a.out,0o700)
db=sqlite3.connect(f'file:{a.snapshot.resolve()}?mode=ro',uri=True);items=[('news','image','news')]
if a.include_users:items.append(('users','photo','profiles'))
if a.include_exports:items.append(('exports','filename','exports'))
sql=[];mapping=[]
for table,column,kind in items:
 for entity_id,old in db.execute(f'SELECT id,{column} FROM {table} WHERE {column} IS NOT NULL AND {column}<>?',('',)):
  root=a.data_dir/('exports' if table=='exports' else 'uploads');path=(root/old).resolve()
  if not path.is_relative_to(root.resolve()) or not path.is_file():raise SystemExit(f'Missing or unsafe file reference: {table}/{entity_id}')
  content=path.read_bytes();ext='.xlsx' if table=='exports' else '.jpg' if content[:2]==b'\xff\xd8' else '.png';key=f'{kind}/legacy/{hashlib.sha256(content).hexdigest()}{ext}'
  mapping.append({'table':table,'id':entity_id,'old':old,'key':key,'sha256':hashlib.sha256(content).hexdigest()})
  if a.apply:
   subprocess.run(['npx','wrangler','r2','object','put',a.bucket+'/'+key,'--file',str(path),'--content-type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' if table=='exports' else 'image/jpeg' if ext=='.jpg' else 'image/png','--remote' if a.remote else '--local']+(['--persist-to',str(a.persist_to)] if a.persist_to and not a.remote else []),check=True)
  sql.append(f"UPDATE {table} SET {column}='{key}' WHERE id={int(entity_id)} AND {column} IN ('{old.replace(chr(39),chr(39)*2)}','{key}');")
(a.out/'mapping.json').write_text(json.dumps(mapping,indent=2)+'\n');(a.out/'references.sql').write_text('\n'.join(sql)+'\n')
if a.apply and sql:subprocess.run(['npx','wrangler','d1','execute','DB','--remote' if a.remote else '--local','--file',str(a.out/'references.sql')]+(['--persist-to',str(a.persist_to)] if a.persist_to and not a.remote else []),check=True)
print(f'{len(mapping)} objects mapped. Original files preserved. '+('Uploaded and references updated.' if a.apply else 'Dry run; use --apply after reviewing mapping.json.'))
