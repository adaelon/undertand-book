import test from 'node:test';
import assert from 'node:assert/strict';
import {ablationReport,observedBodySpans} from './ablation-report.mjs';

test('observed body accounting merges repeated and overlapping admitted ranges, ignores rejected reads',()=>{
  const corpus={base:{lid_nodes:[{lid:'1',span:{start:0,end:8000}},{lid:'2',span:{start:4000,end:12000}}]}};
  const message=(id,lid,text)=>({role:'tool',tool_call_id:id,content:JSON.stringify({model_body:{text},receipt:{tool:'book.text',accepted_evidence:[{start_lid:lid,end_lid:lid}]}})});
  const requests=[{request:{messages:[message('a','1','body'),message('b','2','body'),message('a','1','body'),message('c','missing',undefined)]}}];
  assert.equal(observedBodySpans(requests,corpus),12000);
  assert.equal(observedBodySpans(requests,null),null);
});

test('paired report retains losses, unknown costs and failures without private material',()=>{
  const row=(id,system,success,tokens)=>({id,system,score:{success,semantic_correct:success,facts:1,supported_facts:+success,evidence_groups:1,recalled_groups:+success},
    answer:'PRIVATE_BODY',sources:[],elapsed_ms:1000,usage:{requests:1,total_tokens:tokens,missing_usage:tokens==null?1:0},requests:[{request:{messages:[{role:'user',content:'PRIVATE_BODY'}]},usage:tokens==null?null:{total_tokens:tokens}}]});
  const graph=row('a','graph',true,null);
  graph.outcome={trace:[{tool:'book.context',model_tool_loop:2,args:JSON.stringify({lid:'1.2',granularity:'far',query:'PRIVATE_BODY'}),result_digest:'PRIVATE_BODY'}]};
  const result=ablationReport({qa:[row('a','text',true,1),row('a','tree',false,3),graph],status:'completed'});
  assert.deepEqual(result.comparisons[0].lost,['a']);
  assert.deepEqual(result.comparisons[1].gained,['a']);
  assert.equal(result.comparisons[1].pairs[0].token_delta,null);
  assert.equal(result.rows[2].token_limit_verified,null);
  assert.deepEqual(result.comparisons[1].pairs[0].incremental_locator_calls,[{tool:'book.context',loop:2,lid:'1.2',granularity:'far'}]);
  assert(!JSON.stringify(result).includes('PRIVATE_BODY'));
});
