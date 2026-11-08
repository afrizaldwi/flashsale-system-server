"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { approvedLedgerReplay, auditAcknowledgedOrders } = require("../../scripts/p4/ack-replay");
function fixture() {
  const tx = {idempotencyKey:"ack-1",userId:1,productId:1,qty:2,status:201,timestamp:"2026-11-09T00:00:00Z"};
  let order, writes=0;
  const stats={consistent:true,total_orders:0,total_qty_sold:0,products:[{id:1,stock:10}]};
  const options={transactions:[tx],approval:"Explicit test approval",baseUrl:"http://test",
    http:async(_base,route)=>route==="/stats"?{status:200,body:structuredClone(stats)}:{status:200,body:structuredClone(order)},
    checkout:async(_base,payload,key)=>{
      writes++;
      if(order)return {status:200,body:{result:"DUPLICATE",order:structuredClone(order)}};
      order={id:1,idempotency_key:key,...payload};stats.total_orders++;stats.total_qty_sold+=payload.qty;stats.products[0].stock-=payload.qty;
      return {status:201,body:{result:"CREATED",order:structuredClone(order)}};
    }};
  return {tx,options,stats,writes:()=>writes};
}
test("explicit ledger ACK recovery verifies duplicate, independent lookup and fresh conservation snapshots",async()=>{
 const f=fixture(),r=await approvedLedgerReplay(f.options);
 assert.equal(r.approvals[0].allowLedgerOnly,true);
 const p={user_id:1,product_id:1,qty:2};await r.checkout(p,"ack-1");
 assert.equal(f.writes(),2);assert.equal((await r.lookup("ack-1"))[0].id,1);
 assert.equal((await r.audit()).consistent,true);
 f.stats.products[0].stock--;
 await assert.rejects(r.audit(),/conservation/);
 await assert.rejects(r.checkout(p,"ack-1"),/halted/);
});
test("unapproved or incomplete ledger data fails before writes",async()=>{
 for(const change of [{approval:""},{transactions:[{...fixture().tx,userId:null}]},{transactions:[{...fixture().tx,status:503}]}]){
  const f=fixture();await assert.rejects(approvedLedgerReplay({...f.options,...change}));assert.equal(f.writes(),0);
 }
});
test("a different payload cannot use an approved key",async()=>{
 const f=fixture(),r=await approvedLedgerReplay(f.options);
 await assert.rejects(r.checkout({user_id:2,product_id:1,qty:2},"ack-1"),/Unapproved/);assert.equal(f.writes(),0);
});
test("a duplicate response with a different ID fails closed",async()=>{
 const f=fixture(),checkout=f.options.checkout;let n=0;
 f.options.checkout=async(...args)=>{const r=await checkout(...args);if(++n===2)r.body.order.id=999;return r;};
 const r=await approvedLedgerReplay(f.options);
 await assert.rejects(r.checkout({user_id:1,product_id:1,qty:2},"ack-1"),/duplicate retry/);
});
test("order lookup requires the exact original key",async()=>{
 const f=fixture(),http=f.options.http;
 f.options.http=async(base,route)=>{const r=await http(base,route);if(route.startsWith("/orders/"))r.body.idempotency_key="foreign";return r;};
 const r=await approvedLedgerReplay(f.options);await r.checkout({user_id:1,product_id:1,qty:2},"ack-1");
 await assert.rejects(r.lookup("ack-1"),/lookup failed/);
});
test("final SQL ACK audit rejects missing, duplicate and conflicting rows",()=>{
 const {tx}=fixture(),row={id:1,idempotency_key:tx.idempotencyKey,user_id:1,product_id:1,qty:2};
 assert.equal(auditAcknowledgedOrders([tx],[row]).allResolved,true);
 for(const rows of [[],[row,row],[{...row,qty:1}]])assert.equal(auditAcknowledgedOrders([tx],rows).unresolved,1);
});
