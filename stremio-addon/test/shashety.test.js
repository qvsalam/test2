const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {loadProvider}=require('../lib/provider-loader');
test('Shashety selects exact series and requested later episode',async()=>{
 const calls=[];
 const p=loadProvider(path.resolve(__dirname,'../../providers/shashety.js'),async url=>{
  calls.push(url);
  let data;
  if(url.includes('themoviedb')) data={name:'Breaking Bad',first_air_date:'2008-01-01'};
  else if(url.includes('search?')) data={items:[{id:1,type:'movie',name:'Breaking Bad',year:2008},{id:24194,series_id:24194,type:'series',name:'Breaking Bad',year:2008}]};
  else data=[{season_number:5,episode_number:16,series_id:24194,video_v2:[{full_url:'https://cdn-h.shashety.com/test.mp4',new_resolution:'1080p'}]}];
  return {ok:true,json:async()=>data};
 });
 const streams=await p.getStreams(1396,'tv',5,16);
 assert.equal(streams.length,1);
 assert.ok(calls.some(x=>x.endsWith('seasons/5/series/24194/episode/16')));
 assert.equal((await p.getStreams(1396,'tv',1,1)).length,0);
});
