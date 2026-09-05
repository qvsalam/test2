const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {loadProvider}=require('../lib/provider-loader');
test('CinemaBox movie uses term search, post episode id, and APK player route',async()=>{
 const calls=[];
 const p=loadProvider(path.resolve(__dirname,'../../providers/cinemabox-apk.js'),async url=>{
  calls.push(url);let data;
  if(url.includes('themoviedb')) data={title:'Inception'};
  else if(url.endsWith('search?term=Inception'))data={results:[{id:8978,title:'Inception',type:'MOVIE'}]};
  else if(url.endsWith('dynamic/8978'))data={post_info:{episode_id:234}};
  else if(url.endsWith('episodes/player/234'))data={videos:[{url:'https://cdn6.albox.co/test.mp4',quality:'1080p'}]};
  else throw new Error('Unexpected route '+url);
  return {ok:true,json:async()=>data};
 });
 assert.equal((await p.getStreams(27205,'movie')).length,1);
 assert.ok(calls.some(x=>x.endsWith('episodes/player/234')));
 assert.ok(!calls.some(x=>x.includes('/files')||x.includes('?q=')));
});
