const test = require('node:test');
const assert = require('node:assert/strict');
const {decodeHttpResponse,buildRawRequest}=require('../lib/vless-client');
test('truncated bodies fail instead of returning success',()=>{
 const raw=Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc');
 assert.throws(()=>decodeHttpResponse(raw),/Incomplete/);
 assert.equal(decodeHttpResponse(raw,'HEAD').body.length,0);
});
test('request headers reject CRLF injection',()=>assert.throws(()=>buildRawRequest(new URL('https://example.com'),'GET',{'range':'bytes=0-1\r\nInjected: yes'}),/Invalid/));
