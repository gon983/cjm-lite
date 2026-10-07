import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [dir='.migration',scope='--local']=process.argv.slice(2);
if(!['--local','--remote'].includes(scope))throw Error('Use --local or --remote');
const report=JSON.parse(readFileSync(dir+'/verification.json'));
function query(sql){const r=spawnSync('npx',['wrangler','d1','execute','DB',scope,'--json','--command',sql],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout||'Wrangler query failed');const data=JSON.parse(r.stdout);if(data.error)throw Error(data.error.text);return data[0].results;}
for(const [table,count] of Object.entries(report.target_counts)){if(!['whitelist','news','blocked_days'].includes(table))throw Error('Unexpected table in migration manifest');if(Number(query(`SELECT count(*) AS count FROM ${table}`)[0].count)!==count)throw Error(`Count mismatch for ${table}`)}
if(query('PRAGMA foreign_key_check').length)throw Error('Foreign keys failed');
console.log('Imported counts and foreign keys verified. Original history remains in the protected archive.');
