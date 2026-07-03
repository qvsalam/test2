// CinemaBox APK flow v1.1
var K="ee8ac8a9044c09a11cc362033f98c735",A="https://cinema.albox.co/api/v4/";
function N(s){return String(s||"").toLowerCase().replace(/[’'`]/g,"").replace(/[^a-z0-9\u0600-\u06FF]+/g," ").trim()}
function add(a,v){v=String(v||"").trim();if(v&&a.indexOf(v)<0)a.push(v);v=v.replace(/[’'`]/g,"");if(v&&a.indexOf(v)<0)a.push(v)}
async function J(u){var r=await fetch(u,{headers:{Accept:"application/json, text/plain, */*","User-Agent":"Mozilla/5.0"}});if(!r||!r.ok)return null;return await r.json()}
async function T(id){var u="https://api.themoviedb.org/3/tv/"+id+"?api_key="+K,t=[],e=await J(u+"&language=en").catch(function(){return{}})||{},a=await J(u+"&language=ar").catch(function(){return{}})||{};add(t,e.name);add(t,e.original_name);add(t,e.title);add(t,a.name);add(t,a.original_name);add(t,a.title);return t}
function R(d){return Array.isArray(d)?d:(d&&(d.results||d.data||d.items||d.posts||d.shows||d.result))||[]}
function ID(x){return x&&(x.id||x.show_id||x.post_id||x.nb||x._id||x.uuid||x.episode_id||x.episodeId||x.season_id||x.seasonId)}
function TTL(x){return x&&(x.name||x.title||x.en_name||x.ar_name||x.original_name||x.post_title||x.show_name||x.showTitle)||""}
function OK(x,ts){var a=N(TTL(x));for(var i=0;i<ts.length;i++){var b=N(ts[i]);if(b&&(a===b||a.indexOf(b)>=0||b.indexOf(a)>=0))return true}return false}
function num(x,k){for(var i=0;i<k.length;i++){var v=x&&x[k[i]];if(v!=null){var m=String(v).match(/\d+/);if(m)return parseInt(m[0],10)}}return null}
function EP(x){return num(x,["episodeNumber","episode_number","number","episode","ep_num","ep"])}
function SN(x){return num(x,["seasonNumber","season_number","number","season","season_num"])}
function QS(u){u=String(u||"");if(/1080/.test(u))return"1080p";if(/720/.test(u))return"720p";if(/480/.test(u))return"480p";if(/360/.test(u))return"360p";if(/240/.test(u))return"240p";if(/m3u8/.test(u))return"HLS";return"HD"}
function U(n,o){if(n==null)return;if(typeof n==="string"){var s=n.replace(/\\\//g,"/"),r=/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)(?:\?[^\s"'<>\\]*)?/gi,m;while((m=r.exec(s))!==null)o.push(m[0]);return}if(Array.isArray(n)){for(var i=0;i<n.length;i++)U(n[i],o);return}if(typeof n==="object"){var ks=Object.keys(n);for(var k=0;k<ks.length;k++)U(n[ks[k]],o)}}
function S(d){var us=[];U(d,us);var out=[],seen={};for(var i=0;i<us.length;i++){var u=us[i];if(!seen[u]&&!/trailer|thumb|poster|preview/i.test(u)){seen[u]=1;var q=QS(u);out.push({title:"CinemaBox "+q,name:"CinemaBox",provider:"CinemaBox",url:u,quality:q,type:u.indexOf(".m3u8")>-1?"hls":"direct"})}}return out}
function SEAS(n,o){if(!n||typeof n!=="object")return;if(Array.isArray(n)){for(var i=0;i<n.length;i++)SEAS(n[i],o);return}var sn=SN(n),sid=n.season_id||n.seasonId;if(!sid&&sn&&(n.id||n.nb))sid=n.id||n.nb;if(sid&&sn)o.push({id:sid,n:sn});var ks=Object.keys(n);for(var k=0;k<ks.length;k++)SEAS(n[ks[k]],o)}
function EPS(n,o,ss){if(!n||typeof n!=="object")return;if(Array.isArray(n)){for(var i=0;i<n.length;i++)EPS(n[i],o,ss);return}var e=EP(n),id=ID(n);if(id||S(n).length){n.__s=SN(n)||ss;o.push(n)}var ks=Object.keys(n);for(var k=0;k<ks.length;k++)EPS(n[ks[k]],o,n.__s||ss)}
async function D(show,sea){var u=A+"shows/shows/dynamic/"+show+(sea?"?season_id="+sea:"");var d=await J(u).catch(function(){return null});if(d&&d.data&&!Array.isArray(d.data))d=d.data;if(d&&d.result&&!Array.isArray(d.result))d=d.result;return d}
async function P(id){var d=await J(A+"shows/episodes/player/"+id).catch(function(){return null});return S(d)}
async function SP(id,ep){var d=await J(A+"shows/seasons/player/"+id).catch(function(){return null}),l=[];EPS(d,l,null);for(var i=0;i<l.length;i++){if(EP(l[i])===ep){var s=S(l[i]);return s.length?s:P(ID(l[i]))}}if(l.length>=ep){var x=l[ep-1],s2=S(x);return s2.length?s2:P(ID(x))}return[]}
async function F(show,sea,ep){var d=await D(show,null),ss=[];SEAS(d,ss);for(var i=0;i<ss.length;i++){if(ss[i].n===sea){var a=await SP(ss[i].id,ep);if(a.length)return a;var dd=await D(show,ss[i].id),l=[];EPS(dd,l,sea);for(var j=0;j<l.length;j++){if(EP(l[j])===ep){var s=S(l[j]);return s.length?s:P(ID(l[j]))}}}}return[]}
async function getStreams(tmdbId,mediaType,season,episode){try{var ts=await T(tmdbId),s=parseInt(season,10)||1,e=parseInt(episode,10)||1;for(var t=0;t<ts.length;t++){var q=encodeURIComponent(ts[t]),rs=R(await J(A+"search?query="+q).catch(function(){return null}));if(!rs.length)rs=R(await J(A+"search?q="+q).catch(function(){return null}));for(var i=0;i<rs.length;i++){if(ID(rs[i])&&OK(rs[i],ts)){var out=await F(ID(rs[i]),s,e);if(out.length)return out}}}return[]}catch(err){return[]}}
module.exports={getStreams:getStreams};
