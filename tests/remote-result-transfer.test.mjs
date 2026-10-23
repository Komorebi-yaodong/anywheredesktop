import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {createResultTransfers, RESULT_TRANSFER_MAX_BYTES} from '../main/core/remote/resultTransfer.js'
import {createRemoteCryptoSession} from '../main/core/remote/cryptoSession.js'
import {createHistoryPager} from '../main/core/remote/historyPager.js'

let clock = 1000
const store = createResultTransfers({now: () => clock})
const owner = {}, other = {}
const original = {text: '完整中文😀'.repeat(50000), tasks: [{content: 'untouched'}]}
const expected = structuredClone(original)
const ref = store.put(owner, original)
original.text = 'changed after reference'
const parts = []
const session = createRemoteCryptoSession({sessionId:'session-result-transfer-0001', sendKey:crypto.randomBytes(32), receiveKey:crypto.randomBytes(32), sendDirection:'desktop-to-client', receiveDirection:'client-to-desktop'})
for (let offset = 0; offset < ref.totalBytes;) {
  const reply = store.chunk(owner, {id:ref.id, offset})
  assert.equal(reply.offset, offset)
  assert.equal(reply.sha256, ref.sha256)
  const bytes = Buffer.from(reply.data, 'base64url')
  assert.equal(bytes.length, reply.byteLength)
  parts.push(bytes); offset += bytes.length
  assert.ok(Buffer.byteLength(JSON.stringify(session.encrypt({kind:'response',requestId:'request-chunk-transfer',ok:true,result:reply}))) < 256 * 1024)
}
const joined = Buffer.concat(parts)
assert.equal(crypto.createHash('sha256').update(joined).digest('hex'), ref.sha256)
assert.deepEqual(JSON.parse(joined), expected)
assert.deepEqual(store.chunk(owner,{id:ref.id,offset:0}),store.chunk(owner,{id:ref.id,offset:0}))
assert.throws(()=>store.chunk(other,{id:ref.id,offset:0}),{code:'remote_transfer_expired'})
assert.throws(()=>store.release(other,{id:ref.id}),{code:'remote_transfer_expired'})
for (const offset of [-1, 0.5, ref.totalBytes, NaN]) assert.throws(()=>store.chunk(owner,{id:ref.id,offset}),{code:'remote_transfer_range_invalid'})
assert.throws(()=>store.chunk(owner,{id:ref.id,offset:0,path:'forbidden'}),{code:'remote_parameter_unknown'})
store.release(owner,{id:ref.id})
assert.throws(()=>store.chunk(owner,{id:ref.id,offset:0}),{code:'remote_transfer_expired'})
const expiring = store.put(owner,{text:'expire'})
clock += 5*60*1000
assert.throws(()=>store.chunk(owner,{id:expiring.id,offset:0}),{code:'remote_transfer_expired'})
const owned = store.put(owner,{text:'owner lifecycle'})
const foreign = store.put(other,{text:'other session'})
store.clearOwner(owner)
assert.throws(()=>store.chunk(owner,{id:owned.id,offset:0}),{code:'remote_transfer_expired'})
assert.ok(store.chunk(other,{id:foreign.id,offset:0}))
store.clear()
assert.throws(()=>store.chunk(other,{id:foreign.id,offset:0}),{code:'remote_transfer_expired'})
const bounded = createResultTransfers({maxTotalBytes:10})
assert.throws(()=>bounded.put(owner,{text:'too large'}),{code:'remote_transfer_capacity'})
const many = createResultTransfers()
for(let i=0;i<16;i++)many.put(owner,{index:i})
assert.throws(()=>many.put(owner,{index:17}),{code:'remote_transfer_capacity'})
assert.ok(many.put(other,{index:1}))
assert.throws(()=>many.put(other,{text:'x'.repeat(RESULT_TRANSFER_MAX_BYTES)}),{code:'remote_response_too_large'})
const cycle={};cycle.self=cycle
assert.throws(()=>many.put(other,cycle),{code:'remote_response_invalid'})

// A large task list must neither defer a tiny message nor discard other rows.
const tasks=Array.from({length:10},()=>({content:'中'.repeat(1200),status:'pending',steps:Array.from({length:6},()=>({content:'中'.repeat(1200),status:'pending'}))}))
const messages=Array.from({length:3},(_,i)=>({uiMessageId:`message-${i}`,order:i+1,role:'assistant',payload:{content:'短正文'+i,reasoningContent:'',toolCalls:[]}}))
const page=createHistoryPager().page({conversation:{conversationId:'conversation-transfer-test'},tasks,messages,page:{hasMore:false}},'device-transfer-test','conversation-transfer-test')
assert.deepEqual(page.messages,messages)
assert.deepEqual(page.tasks,tasks)
const pageRef=store.put(owner,page)
const pageParts=[]
for(let offset=0;offset<pageRef.totalBytes;){const chunk=store.chunk(owner,{id:pageRef.id,offset});const bytes=Buffer.from(chunk.data,'base64url');pageParts.push(bytes);offset+=bytes.length}
assert.deepEqual(JSON.parse(Buffer.concat(pageParts)),page)
session.close()
console.log(JSON.stringify({ok:true,suite:'remote-result-transfer',coverage:'immutable SHA/chunks/UTF8/owner/expiry/release/quotas/page metadata'}))
