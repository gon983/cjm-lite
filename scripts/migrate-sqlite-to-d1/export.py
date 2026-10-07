#!/usr/bin/env python3
"""Read-only source + consistent sqlite backup + replayable D1 data SQL. No remote writes."""
import argparse, datetime, json, os, pathlib, sqlite3, unicodedata
p=argparse.ArgumentParser();p.add_argument('database',type=pathlib.Path);p.add_argument('--out',type=pathlib.Path,default=pathlib.Path('.migration'));p.add_argument('--reset-users',action='store_true',help='User-authorized fresh accounts: archive related history, import whitelist/news/blocks only');a=p.parse_args()
if not a.reset_users:p.error('This migration was authorized with fresh accounts. Pass --reset-users; existing accounts/passwords stay archived, never silently imported.')
a.out.mkdir(parents=True,exist_ok=True);os.chmod(a.out,0o700)
source=sqlite3.connect(f'file:{a.database.resolve()}?mode=ro',uri=True)
snapshot=a.out/'original.sqlite'
if snapshot.exists():raise SystemExit('Output snapshot already exists; choose a new --out directory.')
backup=sqlite3.connect(snapshot);source.backup(backup);source.close();backup.execute('PRAGMA foreign_keys=ON')
if backup.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise SystemExit('Source integrity check failed.')
violations=backup.execute('PRAGMA foreign_key_check').fetchall()
if violations:raise SystemExit(f'Source has foreign key violations: {len(violations)}')
archive=a.out/'original-all-data.sql';archive.write_text('\n'.join(backup.iterdump())+'\n');os.chmod(archive,0o600);os.chmod(snapshot,0o600)
counts={t:backup.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ['users','whitelist','mediations','blocked_days','news','sessions','audit_log','exports']}
# Existing mediations reference deleted accounts: retain exact SQL/SQLite history rather than break FKs or invent participants.
target=['whitelist','blocked_days','news']
def value(v):
 if v is None:return 'NULL'
 if isinstance(v,bytes):return "X'"+v.hex()+"'"
 if isinstance(v,(int,float)):return str(v)
 return "'"+str(v).replace("'","''")+"'"
sql=[]
for table in target:
 columns=[r[1] for r in backup.execute('PRAGMA table_info('+table+')')]
 if table=='whitelist' and 'matricula' in columns:columns[columns.index('matricula')]='dni'
 for row in backup.execute('SELECT * FROM '+table):sql.append('INSERT OR IGNORE INTO '+table+'('+','.join(columns)+') VALUES('+','.join(value(v) for v in row)+');')
(a.out/'data.sql').write_text('\n'.join(sql)+'\n');os.chmod(a.out/'data.sql',0o600)
report={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_counts':counts,'target_counts':{t:counts[t] for t in target},'excluded_from_active_d1':['users','sessions','mediations','audit_log','exports'],'history_archive':str(archive),'snapshot':str(snapshot),'mode':'reset-users-authorized','source_modified':False}
(a.out/'verification.json').write_text(json.dumps(report,indent=2)+'\n');os.chmod(a.out/'verification.json',0o600);backup.close();print(json.dumps(report,indent=2))
