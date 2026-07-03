// CinemaBox APK term-search v1.2
var K="ee8ac8a9044c09a11cc362033f98c735",A="https://cinema.albox.co/api/v4/";
async function j(u){var r=await fetch(u,{headers:{Accept:"application/json, text/plain, */*","User-Agent":"Mozilla/5.0"}});return r&&r.ok?await r.json():null}
function ar(x){return Array.isArray(x)?x:(x&&(x.results||x.data||x.items||x.posts||x.shows||x.result))||[]}
function id(x){return x&&(x.id||x.show_id||x.post_id||x.nb||x._id||x.uuid||x.episode_id||x.episodeId||x.season_id||x.seasonId)}
function nm(x){return String((x&&(x.name||x.title||x.en_name||x.ar_name||x.original_name||x.post_title||x.show_name))||"")}
function n(s){return String(s||"").toLowerCase().replace(/[’'`]/g,"").replace(/[^a-z0-9\u0600-\u06ff]+/g," ").trim()}
function ok(x,ts){var a=n(nm(x));for(var i=0;i<ts.length;i++){var b=n(ts[i]);if(b&&(a==b||a.indexOf(b)>=0||b.indexOf(a)>=0))return true}return false}
function no(x,ks){for(var i=0;i<ks.length;i++){var v=x&&x[ks[i]];if(v!=null){var m=String(v).match(/\d+/);if(m)return parseInt(m[0],10)}}return null}
function ep(x){return no(x,["episodeNumber","episode_number","number","episode","ep_num","ep"])}
function sn(x){return no(x,["seasonNumber","season_number","season","season_num"])}
function q(u){u=String(u);if(/1080/.test(u))return"1080p";if(/720/.test(u))return"720p";if(/480/.test(u))return"480p";if(/360/.test(u))return"360p";if(/240/.test(u))return"240p";if(/m3u8/.test(u))return"HLS";return"HD"}
function addUrl(u,o){if(u&&/^https?:/.test(u)&&!/trailer|thumb|poster|preview|srt|vtt/i.test(u)){var qq=q(u);o.push({title:"CinemaBox "+qq,name:"CinemaBox",provider:"CinemaBox",url:u,quality:qq,type:u.indexOf(".m3u8")>-1?"hls":"direct"})}}
function urls(x,o){if(!x)return;if(typeof x==="string")addUrl(x.replace(/\\\//g,"/"),o);else if(Array.isArray(x))for(var i=0;i<x.length;i++)urls(x[i],o);else if(typeof x==="object"){var f=["onlineVideoUrl","online_video_url","fileUrl","file_url","videoUrl","video_url","url","file","src","link","hls","mp4"];for(var k=0;k<f.length;k++)urls(x[f[k]],o)}}
async function tt(id){var u="https://api.themoviedb.org/3/tv/"+id+"?api_key="+K,a=[],e=await j(u+"&language=en").catch(function(){return{}})||{},r=await j(u+"&language=ar").catch(function(){return{}})||{};function ad(v){v=String(v||"").trim();if(v&&a.indexOf(v)<0)a.push(v);v=v.replace(/[’'`]/g,"");if(v&&a.indexOf(v)<0)a.push(v)}ad(e.name);ad(e.original_name);ad(r.name);ad(r.original_name);return a}
async function det(show,sea){var d=await j(A+"shows/shows/dynamic/"+show+(sea?"?season_id="+sea:"")).catch(function(){return null});if(d&&d.data&&!Array.isArray(d.data))d=d.data;if(d&&d.result&&!Array.isArray(d.result))d=d.result;return d}
function seas(x,o){if(!x||typeof x!=="object")return;if(Array.isArray(x)){for(var i=0;i<x.length;i++)seas(x[i],o);return}var s=no(x,["seasonNumber","season_number","number","season","season_num"]),sid=x.season_id||x.seasonId||(s&&(x.id||x.nb));if(sid&&s)o.push({id:sid,n:s});var ks=Object.keys(x);for(var k=0;k<ks.length;k++)seas(x[ks[k]],o)}
function eps(x,o,ss){if(!x||typeof x!=="object")return;if(Array.isArray(x)){for(var i=0;i<x.length;i++)eps(x[i],o,ss);return}var e=ep(x);if(e&&(id(x)||x.onlineVideoUrl||x.fileUrl||x.videoUrl||x.url)){x.__s=sn(x)||ss;o.push(x)}var ks=Object.keys(x);for(var k=0;k<ks.length;k++)eps(x[ks[k]],o,x.__s||ss)}
async function play(eid){var d=await j(A+"shows/episodes/player/"+eid).catch(function(){return null}),o=[];urls(d,o);return o}
async function seasonPlayer(sid,e){var d=await j(A+"shows/seasons/player/"+sid).catch(function(){return null}),l=[];eps(d,l,null);for(var i=0;i<l.length;i++)if(ep(l[i])===e){var o=[];urls(l[i],o);return o.length?o:play(id(l[i]))}return[]}
async function find(show,s,e){var d=await det(show,0),ss=[];seas(d,ss);for(var i=0;i<ss.length;i++)if(ss[i].n===s){var o=await seasonPlayer(ss[i].id,e);if(o.length)return o;var dd=await det(show,ss[i].id),l=[];eps(dd,l,s);for(var k=0;k<l.length;k++)if(ep(l[k])===e){var out=[];urls(l[k],out);return out.length?out:play(id(l[k]))}}return[]}
async function search(term){var q=encodeURIComponent(term),u=["search?page_size=25&page_number=1&term=","search?term=","search?query=","search?q="];for(var i=0;i<u.length;i++){var r=ar(await j(A+u[i]+q).catch(function(){return null}));if(r.length)return r}return[]}
async function getStreams(tmdbId,mediaType,season,episode){try{var ts=await tt(tmdbId),s=parseInt(season,10)||1,e=parseInt(episode,10)||1;for(var t=0;t<ts.length;t++){var rs=await search(ts[t]);for(var i=0;i<rs.length;i++)if(id(rs[i])&&ok(rs[i],ts)){var out=await find(id(rs[i]),s,e);if(out.length)return out}}return[]}catch(x){return[]}}
module.exports={getStreams:getStreams};
