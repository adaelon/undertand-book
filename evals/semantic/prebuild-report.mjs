import fs from 'node:fs';
import path from 'node:path';
const book=path.resolve(process.argv[2]??'.understand-book/quantification-essence');
const output=path.resolve(process.argv[3]??'evals/semantic/results/2026-09-08-la9-v2/prebuild.json');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const files=walk(book), metricFiles=files.filter(f=>path.basename(f)==='metrics.json');
const metrics=metricFiles.map(f=>JSON.parse(fs.readFileSync(f,'utf8')));
const stages={};
for(const m of metrics){
  const s=stages[m.stage]??={attempts:0,statuses:{},executor_ms:0,queue_ms:0,lease_wait_ms:0,writer_ms:0,usage_sources:{}};
  s.attempts++;s.statuses[m.status]=(s.statuses[m.status]??0)+1;
  for(const k of ['executor_ms','queue_ms','lease_wait_ms','writer_ms'])s[k]+=Number.isFinite(m[k])?m[k]:0;
  const source=m.usage?.source??'unavailable';s.usage_sources[source]=(s.usage_sources[source]??0)+1;
}
const report={version:'la9-existing-prebuild-v1',book_id:path.basename(book),measured_at:new Date().toISOString(),
  stored_files:files.length,stored_bytes:files.reduce((n,f)=>n+fs.statSync(f).size,0),
  root_artifacts:files.filter(f=>path.dirname(f)===book).map(f=>({name:path.basename(f),bytes:fs.statSync(f).size})),
  metric_records:metrics.length,stages,actual_provider_tokens:null,elapsed_wall_ms:null,
  limitations:['Existing attempt metrics only; summed executor/queue durations overlap across parallel tasks and are not wall-clock build time.',
    'Historical usage provenance is retained by stage; these records do not establish complete actual Provider usage for the book.',
    'No rebuild and no estimated tokens were used to fill missing historical costs. Unknown extra build cost prevents a numeric amortization point.']};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({files:report.stored_files,bytes:report.stored_bytes,metrics:report.metric_records,stages}));
