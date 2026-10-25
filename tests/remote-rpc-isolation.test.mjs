// Real loopback TLS/WSS + actual E2EE/gateway/session/upload implementations.
// Everything else is synthetic. No application instance, user DB/media or logs.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import https from 'node:https'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {once} from 'node:events'

import {WebSocket} from 'ws'
import {createRemoteGateway} from '../main/core/remote/index.js'
import {createRemoteSessionManager} from '../main/core/remote/sessionManager.js'
import {createRemoteUploadManager} from '../main/core/remote/uploadManager.js'
import {createP256KeyPair, createPairingStartEnvelope, completeDevicePairing, createSessionHello, completeSessionHello} from '../main/core/remote/cryptoSession.js'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes}); return {promise, resolve}}
const secureKey = crypto.randomBytes(32)
const safeStorage = {
 isEncryptionAvailable: () => true,
 encryptString(text) {const nonce=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',secureKey,nonce); const data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]); return Buffer.concat([nonce,cipher.getAuthTag(),data])},
 decryptString(bytes) {const cipher=crypto.createDecipheriv('aes-256-gcm',secureKey,bytes.subarray(0,12)); cipher.setAuthTag(bytes.subarray(12,28)); return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')}
}
const CID='conversation-shared-timeout-fixture', DEVICE='device-shared-timeout-fixture'
const frozen=JSON.parse(await fs.readFile(new URL('../packages/remote-contract/fixtures/v1.0-view.json',import.meta.url),'utf8'))
const validPage={...frozen.page,conversation:{...frozen.page.conversation,conversationId:CID},messages:[]}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'anywhere-shared-timeout-'))
const map=new Map(), dispatched=[]
let gateRead=null, readEntered=null, auditGate=null, auditEntered=null, gateway
const storage={
 async get(key,fallback){return {ok:true,value:structuredClone(map.has(key)?map.get(key):fallback)}},
 async set(key,value){
  if(key==='remote:v2:audit' && auditGate){auditEntered?.resolve(); await auditGate.promise}
  map.set(key,structuredClone(value));return {ok:true}
 }
}
function post(url,body){return new Promise((resolve,reject)=>{const data=JSON.stringify(body); const request=https.request(url,{method:'POST',rejectUnauthorized:false,agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},response=>{let raw='';response.on('data',part=>raw+=part);response.on('end',()=>resolve(JSON.parse(raw)))});request.on('error',reject);request.end(data)})}
async function pair(endpoint){
 const pairing=await gateway.createPairing()
 // getLastPairing/createPairing public result includes only transport QR, not its private fixture context.
 const device=createP256KeyPair(), ephemeral=createP256KeyPair()
 const observed=lastPairing
 const start=await post(endpoint+'/api/v2/pair/start',createPairingStartEnvelope({desktopPublicKey:observed.desktopIdentityPublicKey,clientEphemeralPrivateKey:ephemeral.privateKey,context:{pairingId:observed.pairingId,pairingChallenge:observed.pairingChallenge,desktopId:observed.desktopId},pairingCode:pairing.pairingCode,device:{deviceId:DEVICE,displayName:'Synthetic Phone',platform:'android',deviceModel:'Fixture',appVersion:'audit',publicKey:device.publicKey}}))
 assert.equal(start.ok,true,JSON.stringify(start))
 const paired=completeDevicePairing({devicePrivateKey:device.privateKey,desktopPublicKey:observed.desktopIdentityPublicKey,serverEphemeralPublicKey:start.serverEphemeralPublicKey,clientEphemeralPrivateKey:ephemeral.privateKey,devicePublicKey:device.publicKey,context:{pairingId:observed.pairingId,pairingChallenge:observed.pairingChallenge,desktopId:observed.desktopId},desktopProof:start.desktopProof})
 const confirmed=await post(endpoint+'/api/v2/pair/confirm',{v:2,pairingId:observed.pairingId,pairingAttemptId:start.pairingAttemptId,deviceId:DEVICE,deviceProof:paired.deviceProof})
 assert.equal(confirmed.ok,true,JSON.stringify(confirmed))
 return {rootSecret:paired.rootSecret,desktopId:observed.desktopId}
}
let lastPairing
const item={id:'window-shared-timeout-fixture',type:'window',conversationId:CID,rendererReady:true,remoteHidden:true}
const windows=[item]
const uploads=createRemoteUploadManager({tempRoot:path.join(root,'uploads')})
const manager=createRemoteSessionManager({
 getConfig:async()=>({config:{}}),openConversation:async()=>{throw Error('unexpected open')},openWindow:async()=>{throw Error('unexpected window')},listWindows:()=>windows,getWindowByRef:()=>({isDestroyed:()=>false}),revealRemoteConversationWindow:()=>({ok:true}),uploadManager:uploads,
 dispatchRemoteCommandToWindow:async(windowRef,command)=>{dispatched.push(command); if(command.type==='remote.shutdown'){windows.length=0;manager.handleWindowClosed(windowRef)} if(command.type==='conversation.message.delete') setImmediate(()=>manager.handleRendererEvent({windowRef,payload:{conversationId:CID,requestId:command.requestId,event:'conversation.operation.completed',payload:{revision:3}}}));return {ok:true}},
 broadcastToDevice:(deviceId,event,payload)=>gateway.sendEventToDevice(deviceId,event,payload),
})
let socket,session
try {
 const portServer=https.createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve))
 gateway=createRemoteGateway({app:{getPath:()=>root,getName:()=> 'Synthetic'},safeStorage,dbStorageGetItem:storage.get,dbStorageSetItem:storage.set,getLanAddresses:()=>['127.0.0.1'],sessionManager:manager,uploadManager:uploads,onPairingCreated:value=>{lastPairing=value},conversationReadService:{listWindows:async()=>({ok:true,windows:[]}),listConversations:async()=>({ok:true,configured:true,conversations:[],projects:[],page:{hasMore:false,nextCursor:null}}),listMessages:async()=>{if(gateRead){readEntered?.resolve();await gateRead.promise}return structuredClone(validPage)}},logger:{log(){},warn(){},error(){}}})
 const status=await gateway.configure({remote:{enabled:true,host:'127.0.0.1',port}})
 const endpoint=status.endpoints[0],paired=await pair(endpoint)
 socket=new WebSocket(endpoint.replace('https:','wss:')+'/api/v2/socket',{rejectUnauthorized:false});await once(socket,'open')
 const hello=createSessionHello({rootSecret:paired.rootSecret,deviceId:DEVICE,desktopId:paired.desktopId})
 const welcome=deferred(), pending=new Map(), events=[]
 socket.on('message',raw=>{
  const frame=JSON.parse(raw.toString())
  if(frame.type==='remote.session.accept'){session=completeSessionHello({state:hello.state,accept:frame,expectedDeviceId:DEVICE,expectedDesktopId:paired.desktopId});return}
  const message=session.decrypt(frame)
  if(message.event==='remote.welcome'){welcome.resolve();return}
  if(message.kind==='response'){const receipt=pending.get(message.requestId);if(receipt){pending.delete(message.requestId);receipt.resolve(message)}}
  else events.push(message)
 })
 socket.send(JSON.stringify(hello.hello));await welcome.promise
 let sequence=0
 const request=(method,params={})=>{const requestId='request-probe-'+(++sequence);const reply=deferred();pending.set(requestId,reply);socket.send(JSON.stringify(session.encrypt({kind:'request',requestId,method,params})));return reply.promise}
 await request('remote.contract.negotiate',{versions:[{major:1,minor:1}]})
 const first=await request('conversation.send',{conversationId:CID,text:'synthetic initial'})
 assert.equal(first.ok,true,JSON.stringify(first))
 const parent=dispatched.at(-1)
 manager.handleRendererEvent({windowRef:item.id,payload:{conversationId:CID,requestId:parent.requestId,event:'assistant.completed',payload:{revision:1}}})
 const raw=Buffer.alloc(7*1024*1024,17),chunk=512*1024
 const begin=await request('transfer.request',{method:'attachment.begin',params:{name:'synthetic-photo.jpg',type:'image/jpeg',size:raw.length,sha256:crypto.createHash('sha256').update(raw).digest('base64url')}})
 assert.equal(begin.ok,true,JSON.stringify(begin));const uploadId=begin.result.upload.uploadId
 const ack0=await request('transfer.request',{method:'attachment.chunk',params:{uploadId,index:0,data:raw.subarray(0,chunk).toString('base64url')}})
 assert.equal(ack0.ok,true,JSON.stringify(ack0))
 console.log(JSON.stringify({probe:'control',firstChunkBytes:ack0.result.upload.receivedBytes,percentage:Math.round(100*ack0.result.upload.receivedBytes/raw.length),socket:'open'}))
 // Keep history unresolved while unrelated business requests complete.
 gateRead=deferred();readEntered=deferred()
 const blockedRead=request('resource.get',{resource:'conversation.messages.list',params:{conversationId:CID,pageSize:1}})
 await readEntered.promise
 const started=Date.now(),delivered={}

 const lightControl=await request('conversation.control.get',{conversationId:CID});assert.equal(lightControl.ok,true);assert.equal(lightControl.result.control.owner,'this_device')

 const chunk1=request('transfer.request',{method:'attachment.chunk',params:{uploadId,index:1,data:raw.subarray(chunk,2*chunk).toString('base64url')}}).then(value=>{delivered.chunk=value;return value})
 const view=request('conversation.view.get',{conversationId:CID,pageSize:1}).then(value=>{delivered.view=value;return value})
 const ping=request('remote.ping').then(value=>{delivered.ping=value;return value})
 // Mobile sends a read precondition before delete; also queue an actual delete command.
 const issuedAt=Date.now(),operationId=`command-${issuedAt}-delete-shared-timeout`
 const runtime=manager.runtimeSnapshot({deviceId:DEVICE,params:{conversationId:CID}})
 const deletion=request('command.submit',{commandId:operationId,issuedAt,method:'conversation.message.delete',params:{conversationId:CID,uiMessageId:'ui-message-synthetic-fixture'},preconditions:{controlEpoch:runtime.control.epoch}}).then(value=>{delivered.delete=value;return value})
 let nativePong=false;socket.once('pong',()=>{nativePong=true});socket.ping()
 await sleep(300)
 assert.equal(delivered.chunk?.ok,true);assert.equal(delivered.ping?.ok,true);assert.equal(delivered.delete?.ok,true)
 assert.equal(delivered.view,undefined)
 assert.equal(dispatched.some(command=>command.type==='conversation.message.delete'),true)
 assert.equal(nativePong,true,'native heartbeat works while application RPC queue is blocked')
 assert.equal(socket.readyState,WebSocket.OPEN)
 console.log(JSON.stringify({probe:'isolated-real-rpc',waitedMs:Date.now()-started,chunkAndDeleteAndPingRespond:true,historyStillWaiting:true,nativePong}))
 gateRead.resolve();gateRead=null
 const results=await Promise.all([blockedRead,chunk1,view,ping,deletion]);assert.ok(results.every(result=>result.ok),JSON.stringify(results))
 assert.equal(dispatched.filter(command=>command.type==='conversation.message.delete').length,1)
 console.log(JSON.stringify({probe:'after-read-released',elapsedMs:Date.now()-started,chunkAndDeleteBothSucceed:true,oneDeleteOnly:true}))
 // Explicit log viewing flushes storage, but must not stall the socket lane.
 auditGate=deferred();auditEntered=deferred()
 const flushing=gateway.getAuditLog()
 await auditEntered.promise
 const beforeAudit=request('remote.ping');assert.equal((await beforeAudit).ok,true)
 let followingDone=false
 const following=request('remote.ping').then(value=>{followingDone=true;return value})
 await sleep(400);assert.equal(followingDone,true)
 auditGate.resolve();auditGate=null
 await flushing
 assert.equal((await following).ok,true)
 console.log(JSON.stringify({probe:'audit-head-of-line',previousAckAlreadyReceived:true,nextRpcBlockedUntilAudit:false,delayMs:400}))
 // End-to-end replay rejection still uses the ordered AEAD receive lane.
 const replay=session.encrypt({kind:'request',requestId:'request-replay-fixture',method:'remote.ping',params:{}})
 const replayed=once(socket,'close')
 socket.send(JSON.stringify(replay));socket.send(JSON.stringify(replay))
 const [closeCode]=await replayed
 assert.equal(closeCode,4003)
 console.log(JSON.stringify({ok:true,suite:'remote-rpc-isolation',replayedFrameRejected:true}))

} finally {
 gateRead?.resolve();auditGate?.resolve()
 if(socket){socket.close();await Promise.race([once(socket,'close'),sleep(1000)]);socket.terminate()}
 session?.close();if(gateway)await gateway.stop().catch(()=>{})
 await fs.rm(root,{recursive:true,force:true})
}
