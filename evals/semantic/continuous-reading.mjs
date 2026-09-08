// LA10: real frontend + production service, isolated persistent memory, no API mocks.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {startServer} from './server.mjs';
import {startProviderRecorder, measuredUsage} from './provider-recorder.mjs';
import {loadCorpus} from './core.mjs';
const root=process.cwd();
process.loadEnvFile(path.join(root,'.env'));
const output=path.resolve(process.argv[2]??'tmp/la10');
if (fs.existsSync(path.join(output,'run.json'))) throw new Error('Output already exists; choose a new directory to preserve the previous replay.');
fs.mkdirSync(output,{recursive:true});
const memory=path.join(output,'memory');
const book=path.resolve('.understand-book/quantification-essence');
const corpus=loadCorpus(book);
const result={version:'la10-v1',started_at:new Date().toISOString(),status:'running',steps:[]};
const save=()=>fs.writeFileSync(path.join(output,'run.json'),JSON.stringify(result,null,2)+'\n');
const pass=(stage,details={})=>{result.steps.push({stage,status:'passed',...details});save();console.log('PASS',stage);};
const recorder=await startProviderRecorder(process.env.OPENCODE_BASE_URL);
const env={OPENCODE_BASE_URL:recorder.url,UNDERSTAND_BOOK_PRIVATE_DIR:path.join(output,'private')};
let server, browser, page, stage='startup';
async function open(){
  server=await startServer(book,memory,root,env);
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1500,height:1000}});
  page.setDefaultTimeout(30000);
  await page.goto(server.url,{waitUntil:'domcontentloaded'});
  await page.locator('.agent-input textarea').waitFor();
}
async function chat(message){
  await page.locator('.agent-input textarea').fill(message);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/agent/chat'),{timeout:300000});
  await page.locator('.agent-input > button').click();
  const r=await response, outcome=await r.json();
  if(stage==='selection_explanation') {
    const request=r.request().postDataJSON();
    assert(request.question_quote?.ranges?.length>0,'Markdown selection lost its exact ranges');
    assert.equal(request.question_quote.status,'resolved');
  }
  result[stage]={outcome,http_status:r.status()}; save();
  assert(r.ok() && !outcome.incomplete && outcome.answer?.length>0,stage+': Agent did not complete');
  return outcome;
}
try{
  await open();
  stage='selection_explanation';
  const target=page.locator('.reader-pane .flow-text').filter({hasText:/.{25}/}).first();
  await target.waitFor();
  const lid=await target.getAttribute('data-lid');
  const quote=await target.innerText();
  await target.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const s=window.getSelection();s.removeAllRanges();s.addRange(range);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
  await page.locator('.hl-popover').getByRole('button',{name:'问 AI',exact:true}).click();
  const answer=await chat('请解释我选中的原文，用两句话回答，并给出可以点击核对的原文来源。');
  assert(answer.answer_view?.sources.length>0,'selection answer has no source');
  pass(stage,{lid,quote});
  stage='source_popup';
  const before=await server.api('reader/state',{},'POST');
  let opened=0;page.on('request',r=>{if(r.url().endsWith('/agent/source.open'))opened++;});
  const resolved=page.waitForResponse(r=>r.url().endsWith('/agent/source.resolve'));
  await page.locator('.agent-source-button').last().click();
  const source=await(await resolved).json();
  await page.locator('.source-highlight').waitFor();
  assert.equal(await page.locator('.source-highlight').innerText(),source.highlighted_quote);
  assert(corpus.source.includes(source.highlighted_quote));
  assert.equal((await server.api('reader/state',{},'POST')).viewport.top_lid,before.viewport.top_lid);
  assert.equal(opened,0);
  pass(stage,{source_ref_id:source.source_ref_id,quote:source.highlighted_quote});
  stage='explicit_navigation';
  const opening=page.waitForResponse(r=>r.url().endsWith('/agent/source.open'));
  await page.getByRole('button',{name:'在正文中查看',exact:true}).click();
  assert((await opening).ok());
  await page.waitForFunction(q=>document.querySelector('.reader-pane')?.textContent.includes(q),source.highlighted_quote);
  const at=(await server.api('reader/state',{},'POST')).viewport.top_lid;
  pass(stage,{top_lid:at});
  stage='save_note';
  const note='LA10 阅读笔记：先确认原文证据，再区分解释与结论。';
  const noteTarget=page.locator('.reader-pane .flow-text').filter({hasText:/.{25}/}).first();
  await noteTarget.click();
  await page.locator('.block-actions').getByRole('button',{name:'记笔记',exact:true}).first().click();
  await page.locator('.note-dialog textarea').fill(note);
  const savedResponse=page.waitForResponse(r=>r.url().endsWith('/reader/note'));
  await page.locator('.note-dialog .primary').click();
  assert((await savedResponse).ok());
  const records=await server.api('memory/recall',{book_id:corpus.base.book_id},'POST');
  const saved=(Array.isArray(records)?records:records.records).find(r=>r.content===note);
  assert(saved);pass(stage,{record:saved});
  stage='restart';
  const position=(await server.api('reader/state',{},'POST')).viewport.top_lid;
  const previousPid=server.child.pid;
  await browser.close();browser=null;await server.stop();server=null;
  await open();
  assert.notEqual(server.child.pid,previousPid);
  assert.equal((await server.api('reader/state',{},'POST')).viewport.top_lid,position);
  const restored=await server.api('memory/recall',{book_id:corpus.base.book_id},'POST');
  assert((Array.isArray(restored)?restored:restored.records).some(r=>r.mem_id===saved.mem_id&&r.content===note&&r.anchor.lid===saved.anchor.lid));
  assert(await page.locator('.reader-pane').innerText());
  pass(stage,{top_lid:position,record_id:saved.mem_id});
  stage='new_chat_recovery';
  const fresh=page.waitForResponse(r=>r.url().endsWith('/agent/new'));
  await page.locator('.new-chat').click();assert((await fresh).ok());
  assert.equal((await server.api('agent/history')).current.turns.length,0);
  const recovered=await chat('请找回我保存的 LA10 阅读笔记，引用笔记的完整原文，并实际读取当前恢复的阅读位置。');
  assert(recovered.answer.includes(note));
  assert(recovered.trace.some(t=>t.tool==='memory.recall'));
  assert(recovered.trace.some(t=>t.tool==='reader.state'));
  pass(stage);
  stage='cross_chapter_sources';
  const cross=await chat('因子的信息含量与样本外验证分别解决什么问题？请联系两个章节的原文，简短回答，并分别提供两个章节的可点击来源。');
  assert(cross.answer_view.sources.length>=2);
  const history=await server.api('agent/history'),turn_id=history.current.turns.at(-1).turn_id;
  const verified=[];
  for(const s of cross.answer_view.sources){const v=await server.api('agent/source.resolve',{turn_id,source_ref_id:s.source_ref_id},'POST');assert(v.can_open_in_reader&&!v.stale&&corpus.source.includes(v.highlighted_quote));verified.push(v);}
  // Click every source in the final answer, including grouped popup tabs.
  const buttons=page.locator('.turn').last().locator('.agent-source-button');
  await buttons.first().waitFor({state:'visible'});
  const count=await buttons.count();
  assert(count>0,'final answer source buttons absent');
  for(let i=0;i<count;i++){
    await buttons.nth(i).click();await page.locator('.source-highlight').waitFor();
    const tabs=page.locator('.source-tabs [role=tab]');
    for(let j=0;j<await tabs.count();j++){await tabs.nth(j).click();await page.waitForFunction(()=>!!document.querySelector('.source-highlight')?.textContent);assert(corpus.source.includes(await page.locator('.source-highlight').innerText()));}
    await page.getByRole('button',{name:'关闭来源',exact:true}).click();
  }
  pass(stage,{sources:verified});
  result.status='passed';
}catch(error){result.status='failed';result.failure={stage,message:error.message};console.error('FAIL',stage,error.message);}
finally{if(page)await page.screenshot({path:path.join(output,'final.png'),fullPage:true}).catch(()=>{});if(browser)await browser.close();if(server)await server.stop();await recorder.stop(60000);result.requests=recorder.records;result.usage=measuredUsage(recorder.records);result.finished_at=new Date().toISOString();save();}
process.exitCode=result.status==='passed'?0:1;
