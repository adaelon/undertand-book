// Resume only the final UI verification of an already saved LA10 conversation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startServer} from './server.mjs';
import {loadCorpus} from './core.mjs';
const output=path.resolve(process.argv[2]),file=path.join(output,'run.json');
const result=JSON.parse(fs.readFileSync(file,'utf8'));
assert.equal(result.failure?.stage,'cross_chapter_sources');
assert(['selection_explanation','source_popup','explicit_navigation','save_note','restart','new_chat_recovery'].every(stage=>result.steps.some(s=>s.stage===stage&&s.status==='passed')));
assert(result.cross_chapter_sources.outcome.answer_view.sources.length>=2);
process.loadEnvFile('.env');
const book=path.resolve('.understand-book/quantification-essence'),corpus=loadCorpus(book);
const server=await startServer(book,path.join(output,'memory'),process.cwd(),{UNDERSTAND_BOOK_PRIVATE_DIR:path.join(output,'private')});
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  await page.goto(server.url,{waitUntil:'domcontentloaded'});
  const buttons=page.locator('.transcript .turn').last().locator('.agent-source-button');
  await buttons.first().waitFor({timeout:60000});
  const history=await server.api('agent/history');
  assert.equal(history.current.turns.at(-1).outcome.answer,result.cross_chapter_sources.outcome.answer);
  const clicked=[];
  for(let i=0;i<await buttons.count();i++){
    const resolved=page.waitForResponse(r=>r.url().endsWith('/agent/source.resolve'));
    await buttons.nth(i).click();const source=await(await resolved).json();
    await page.locator('.source-highlight').waitFor();
    assert.equal(await page.locator('.source-highlight').innerText(),source.highlighted_quote);
    assert(corpus.source.includes(source.highlighted_quote));
    clicked.push({label:source.label,source_ref_id:source.source_ref_id});
    await page.getByRole('button',{name:'关闭来源',exact:true}).click();
  }
  assert(clicked.length>=2);
  assert(new Set(clicked.map(s=>s.label)).size>=2,'sources must cover distinct chapter labels');
  if(!fs.existsSync(path.join(output,'run-initial.json')))fs.copyFileSync(file,path.join(output,'run-initial.json'));
  result.replay_failure=result.failure;delete result.failure;
  result.steps.push({stage:'cross_chapter_sources',status:'passed',sources:clicked});
  result.status='passed';result.resumed_from_saved_conversation=true;result.finished_at=new Date().toISOString();
  fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');
  await page.screenshot({path:path.join(output,'sources-verified.png'),fullPage:true});
  console.log('PASS saved cross-chapter source clicks',JSON.stringify(clicked));
}finally{await browser.close();await server.stop();}
