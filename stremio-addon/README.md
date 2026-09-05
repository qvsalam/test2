# Stremio addon adapter

هذا مجلد إضافة Stremio يلفّ مزوّدات `providers/` الموجودة في الريبو ويحوّلها إلى بروتوكول Stremio:

- `GET /manifest.json`
- `GET /catalog/movie/iraq-movies.json?search=...`
- `GET /catalog/series/iraq-series.json?search=...`
- `GET /meta/:type/:id.json`
- `GET /stream/:type/:id.json`
- `GET /health`

## التشغيل داخل الريبو

ضع المجلد باسم `stremio-addon/` بجانب `providers/`، ثم شغّله من جذر الريبو:

```text
PROVIDERS_DIR=providers
VLESS_URL=vless://...   # سرّ، لا تضعه داخل الكود أو manifest
PROXY_TOKEN=رمز_عشوائي_طويل
TMDB_API_KEY=مفتاح_TMDB
STREAM_HOSTS=movie.vodu.me,isp.vodu.me,cinema.albox.co,pucinema.albox.co,cinemana.shabakaty.cc,cinemana.shabakaty.com,api-cinema.shashety.com,apitv.shashety.com,cdn.shashety.com
cd stremio-addon
npm install
npm start
```

`VLESS_URL` يبقى متغيّر بيئة داخل خدمة Node. الإضافة لا تضعه في manifest أو استجاباتها. طلبات API للمضيفات الموجودة في allow-list تمر عبر VLESS، وروابط الفيديو تُعاد كروابط `/proxy` موقعة بـ`PROXY_TOKEN`.

لا تضع أي رمز سري في query string يدويًا. رابط `sig` في stream هو توقيع غير قابل للعكس، وليس قيمة `PROXY_TOKEN` نفسها.

## Render

ملف `render.yaml` في جذر الريبو ينشئ خدمة Node واحدة. اضبط `VLESS_URL` و`TMDB_API_KEY` كمتغيرات سرية؛ `PROXY_TOKEN` يتولد تلقائيًا من Render. لا تضع أيًا من هذه القيم داخل `manifest.json`.

الـproxy يدعم Range للفيديو ويعيد كتابة روابط HLS الداخلية إلى روابط موقعة تمر عبر VLESS. لا يسمح بتمرير أي مضيف غير موجود في `STREAM_HOSTS`؛ أضف نطاقات CDN المطلوبة صراحةً بعد التحقق منها. الخطة المجانية في Render قد تنام بعد الخمول وتملك حدًا للخروج الشبكي، لذلك تشغيل فيديو طويل قد يتطلب خطة مدفوعة أو VPS إذا استُهلك الحد.

## ملاحظات التوافق

المزوّدات الحالية لا تصدّر `catalog` أو `meta`؛ لذلك يستخدم هذا الغلاف TMDB للفهرسة والبيانات، ويستدعي `getStreams()` من كل مزوّد بالتوازي. يتم تحميل ملفات المزودات في VM مع `fetch` عبر عميل VLESS للمضيفات الموجودة في allow-list.

إذا لم تضبط `VLESS_URL`، ترجع مسارات stream فارغة لحماية الخدمة من الرجوع غير المقصود إلى اتصال Render المباشر. يمكن تفعيل الاتصال المباشر للاختبار المحلي فقط عبر `ALLOW_DIRECT_PROVIDER_FETCH=true`.
