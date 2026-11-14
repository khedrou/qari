(function(){
'use strict';
var $=function(s){return document.querySelector(s)};
var ALGO=2; // bump when text extraction changes, so cached books get rebuilt

/* ---------- small utils ---------- */
var tt;
function toast(m){var t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(tt);tt=setTimeout(function(){t.classList.remove('on')},2800)}
function loading(on){$('#loading').hidden=!on}
function hash(s){var h=5381;for(var i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))|0}return (h>>>0).toString(36)}
function cleanName(n){return String(n||'').replace(/\.pdf$/i,'').replace(/[_]+/g,' ').trim()||'كتاب'}
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e}
function debounce(fn,ms){var t;return function(){clearTimeout(t);t=setTimeout(fn,ms)}}
function tick(){return new Promise(function(r){setTimeout(r,0)})}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function libUrl(p){return new URL(p,document.baseURI).href}
var reduced=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- local storage with in-memory fallback ---------- */
var memLS={};
function lsGet(k){try{var v=localStorage.getItem(k);return v===null?(memLS[k]===undefined?null:memLS[k]):v}catch(e){return memLS[k]===undefined?null:memLS[k]}}
function lsSet(k,v){memLS[k]=v;try{localStorage.setItem(k,v)}catch(e){}}
function lsDel(k){delete memLS[k];try{localStorage.removeItem(k)}catch(e){}}

/* ---------- IndexedDB (books = the PDF files, texts = extracted text cache) ---------- */
var idb=null, mem={books:{},texts:{}};
function openDB(){
  return new Promise(function(res){
    try{
      var r=indexedDB.open('qari-books',2);
      r.onupgradeneeded=function(){
        var d=r.result;
        if(!d.objectStoreNames.contains('books'))d.createObjectStore('books',{keyPath:'id'});
        if(!d.objectStoreNames.contains('texts'))d.createObjectStore('texts',{keyPath:'id'});
      };
      r.onsuccess=function(){res(r.result)};
      r.onerror=function(){res(null)};
      r.onblocked=function(){res(null)};
    }catch(e){res(null)}
  });
}
function req(store,mode,fn){
  return new Promise(function(res){
    if(!idb)return res(mode==='readonly'?undefined:false);
    try{
      var t=idb.transaction(store,mode),r=fn(t.objectStore(store));
      if(mode==='readonly'){r.onsuccess=function(){res(r.result)};r.onerror=function(){res(undefined)}}
      else{t.oncomplete=function(){res(true)};t.onerror=function(){res(false)};t.onabort=function(){res(false)}}
    }catch(e){res(mode==='readonly'?undefined:false)}
  });
}
var db={
  all:async function(s){
    var a=(await req(s,'readonly',function(o){return o.getAll()}))||[];
    var ids={};a.forEach(function(x){ids[x.id]=1});
    Object.keys(mem[s]).forEach(function(k){if(!ids[k])a.push(mem[s][k])});
    return a;
  },
  get:async function(s,id){
    if(mem[s][id])return mem[s][id];
    return (await req(s,'readonly',function(o){return o.get(id)}))||null;
  },
  put:async function(s,rec){mem[s][rec.id]=rec;return await req(s,'readwrite',function(o){return o.put(rec)})},
  del:async function(s,id){delete mem[s][id];return await req(s,'readwrite',function(o){return o.delete(id)})}
};

/* ---------- settings / progress / bookmarks ---------- */
var FONTS={
  amiri:"'Amiri','Noto Naskh Arabic',serif",
  naskh:"'Noto Naskh Arabic','Amiri',serif",
  cairo:"'Cairo',system-ui,sans-serif",
  tajawal:"'Tajawal','Cairo',sans-serif",
  literata:"'Literata',Georgia,serif"
};
var FONT_LABELS={amiri:'أميري',naskh:'نسخ',cairo:'القاهرة',tajawal:'تجوال',literata:'Literata'};
var FONT_FIRST={amiri:'Amiri',naskh:'Noto Naskh Arabic',cairo:'Cairo',tajawal:'Tajawal',literata:'Literata'};
var THEMES=[['paper','أبيض','#fafaf8','#1b1d21'],['sepia','ورق','#f0e3c6','#3b2f1e'],['dark','داكن','#1a1c20','#d9dce1'],['black','أسود','#000000','#bfc3ca']];
var S={theme:null,mode:'page',fs:22,ff:'amiri',lh:1.9,pad:22,just:true,bright:100,warm:0,awake:true,flip:'auto'};
(function(){
  try{var o=JSON.parse(lsGet('qari.s')||'{}');Object.keys(o).forEach(function(k){if(k in S)S[k]=o[k]})}catch(e){}
  if(S.mode!=='page'&&S.mode!=='scroll')S.mode='page';
  if(typeof S.flip!=='string')S.flip='auto';
  if(!S.theme){S.theme=(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'paper'}
})();
function save(){lsSet('qari.s',JSON.stringify(S))}
function prog(id){try{return JSON.parse(lsGet('qari.p.'+id)||'{}')}catch(e){return {}}}
function setProg(id,o){var p=prog(id);Object.keys(o).forEach(function(k){p[k]=o[k]});lsSet('qari.p.'+id,JSON.stringify(p))}
function loadBms(id){try{var a=JSON.parse(lsGet('qari.bm.'+id)||'[]');return Array.isArray(a)?a:[]}catch(e){return []}}
function saveBms(id,a){lsSet('qari.bm.'+id,JSON.stringify(a))}

/* =====================================================================
   Text extraction: PDF pages -> rows -> clean paragraphs and headings
   ===================================================================== */
var RE_AR=/[؀-ۿݐ-ݿࢠ-ࣿ]/g;
var RE_LAT=/[A-Za-z]/g;
var TERM=/[.!?؟:…»”"')\]۔]$/;
var DIG='0-9٠-٩۰-۹';
var PAGENUM=new RegExp('^[\\s\\-–—.()\\[\\]]*['+DIG+']{1,4}[\\s\\-–—.()\\[\\]]*$');
var NUMS=new RegExp('['+DIG+']+','g');
var NUMEND=new RegExp('\\s['+DIG+']{1,4}$');   // a line that ends with a page number (table of contents)

function normStr(s){
  s=String(s).normalize('NFKC');
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F­�]/g,'').replace(/\s+/g,' ');
}

/* group the text items of one page into lines (rows), top to bottom */
function pageRows(tc){
  var lines=[];
  /* direction of the whole page, measured on normalized text (PDFs often store Arabic as presentation forms) */
  var pAr=0,pLa=0;
  tc.items.forEach(function(it){
    if(typeof it.str!=='string'||!it.str.length)return;
    var n=it.str.normalize('NFKC');
    pAr+=(n.match(RE_AR)||[]).length;pLa+=(n.match(RE_LAT)||[]).length;
  });
  var pageRtl=pAr>pLa;
  tc.items.forEach(function(it){
    if(typeof it.str!=='string'||!it.str.length)return;
    var x=it.transform[4],y=it.transform[5];
    var h=Math.hypot(it.transform[2],it.transform[3])||it.height||10;
    var L=null;
    for(var i=lines.length-1;i>=0&&i>=lines.length-40;i--){
      if(Math.abs(lines[i].y-y)<=Math.max(2,Math.min(lines[i].h,h)*0.4)){L=lines[i];break}
    }
    if(!L){L={y:y,h:0,hc:0,it:[]};lines.push(L)}
    L.it.push({x:x,w:it.width||0,s:it.str});
    if(it.str.trim().length>L.hc){L.hc=it.str.trim().length;L.h=h}
  });
  var rows=[];
  lines.forEach(function(l){
    var all=l.it.map(function(t){return t.s}).join('').normalize('NFKC');
    var ar=(all.match(RE_AR)||[]).length,la=(all.match(RE_LAT)||[]).length;
    var rtl=ar>la?true:(la>ar?false:pageRtl);
    l.it.sort(function(a,b){return rtl?(b.x-a.x):(a.x-b.x)});
    var s='',prev=null,x0=Infinity,x1=-Infinity;
    l.it.forEach(function(t){
      if(prev){
        var gap=rtl?(prev.x-(t.x+t.w)):(t.x-(prev.x+prev.w));
        if(gap>l.h*0.18&&!/\s$/.test(s)&&!/^\s/.test(t.s))s+=' ';
      }
      s+=t.s;prev=t;
      if(t.x<x0)x0=t.x;if(t.x+t.w>x1)x1=t.x+t.w;
    });
    s=normStr(s).trim();
    if(s)rows.push({s:s,y:l.y,h:l.h,x0:x0,x1:x1});
  });
  rows.sort(function(a,b){return b.y-a.y});
  return rows;
}

async function extractPages(pdfDoc,onProgress,cancelled){
  var n=pdfDoc.numPages,pages=[];
  for(var i=1;i<=n;i++){
    if(cancelled())throw new Error('cancel');
    var pg=await pdfDoc.getPage(i);
    var H=pg.getViewport({scale:1}).height;
    var tc=await pg.getTextContent();
    pages.push({H:H,rows:pageRows(tc)});
    try{pg.cleanup()}catch(e){}
    if(i%3===0||i===n){onProgress(i/n);await tick()}
  }
  return pages;
}

function joinLine(a,b){
  if(/[A-Za-z]-$/.test(a)&&/^[a-z]/.test(b))return a.slice(0,-1)+b;
  return a+' '+b;
}
function median(a){if(!a.length)return 0;a=a.slice().sort(function(x,y){return x-y});return a[a.length>>1]}

function buildBlocks(pages){
  var n=pages.length,i;
  /* 1. running headers, footers and page numbers */
  var counts={},cands=[];
  pages.forEach(function(pg,pi){
    var r=pg.rows,c=[];
    if(r.length){
      if(pg.H-r[0].y<pg.H*0.14)c.push(r[0]);
      if(r.length>1&&r[r.length-1].y<pg.H*0.14)c.push(r[r.length-1]);
    }
    c.forEach(function(row){var k=row.s.replace(NUMS,'#').replace(/\s+/g,' ').trim();row._k=k;counts[k]=(counts[k]||0)+1});
    cands.push(c);
  });
  var thr=n>=4?Math.max(3,Math.ceil(n*0.3)):1e9;
  pages.forEach(function(pg,pi){
    var drop=new Set();
    cands[pi].forEach(function(row){
      if(PAGENUM.test(row.s)||(counts[row._k]>=thr&&row.s.length<=100))drop.add(row);
    });
    pg.keep=pg.rows.filter(function(r){return !drop.has(r)});
  });

  /* 2. body font size = most common size, by characters */
  var sizes={};
  pages.forEach(function(pg){pg.keep.forEach(function(r){var k=Math.round(r.h*2)/2;sizes[k]=(sizes[k]||0)+r.s.length})});
  var bodyH=10,best=0;
  Object.keys(sizes).forEach(function(k){if(sizes[k]>best){best=sizes[k];bodyH=+k}});
  var gaps=[];
  pages.forEach(function(pg){
    for(i=1;i<pg.keep.length;i++){
      var a=pg.keep[i-1],b=pg.keep[i],g=a.y-b.y;
      if(a.h/bodyH<1.15&&b.h/bodyH<1.15&&g>0&&g<bodyH*3)gaps.push(g);
    }
  });
  var lineGap=median(gaps)||bodyH*1.4;

  /* 3. paragraphs and headings (a paragraph can continue on the next page) */
  var blocks=[],cur=null;
  function flush(){if(cur&&cur.t.trim())blocks.push({t:cur.t.trim(),h:0,p:cur.p});cur=null}
  pages.forEach(function(pg,pi){
    var rows=pg.keep;if(!rows.length)return;
    var x0m=Infinity,x1m=-Infinity;
    rows.forEach(function(r){if(r.h/bodyH<1.15){if(r.x0<x0m)x0m=r.x0;if(r.x1>x1m)x1m=r.x1}});
    var wide=Math.max(1,x1m-x0m),prev=null,first=true;
    rows.forEach(function(r){
      var ratio=r.h/bodyH;
      if(ratio>=1.18&&r.s.length<=100){
        flush();
        var lvl=ratio>=1.5?1:2,last=blocks[blocks.length-1];
        if(last&&last.h===lvl&&last.p===pi&&prev&&prev.head&&(prev.y-r.y)<r.h*2.2)last.t+=' '+r.s;
        else blocks.push({t:r.s,h:lvl,p:pi});
        prev={y:r.y,head:true};first=false;return;
      }
      if(cur){
        var brk=first?TERM.test(cur.t)
          :((prev.y-r.y)>lineGap*1.45||((prev.x1-prev.x0)<wide*0.62&&TERM.test(prev.s))||(NUMEND.test(prev.s)&&(prev.x1-prev.x0)<wide*0.9));
        if(brk)flush();
      }
      if(!cur)cur={t:r.s,p:pi};else cur.t=joinLine(cur.t,r.s);
      prev={y:r.y,head:false,x0:r.x0,x1:r.x1,s:r.s};first=false;
    });
  });
  flush();

  var chars=0,ar=0,la=0;
  blocks.forEach(function(b){chars+=b.t.length;ar+=(b.t.match(RE_AR)||[]).length;la+=(b.t.match(RE_LAT)||[]).length});
  return {blocks:blocks,rtl:ar>la,scanned:!blocks.length||chars<30*n,chars:chars};
}

/* table of contents: the PDF outline if there is one, otherwise the detected headings */
function firstBlockOfPage(blocks,pg){
  var lo=0,hi=blocks.length;
  while(lo<hi){var m=(lo+hi)>>1;if(blocks[m].p>=pg)hi=m;else lo=m+1}
  return Math.min(lo,blocks.length-1);
}
async function buildToc(pdfDoc,blocks){
  var out=[];
  try{
    var ol=await pdfDoc.getOutline();
    if(ol&&ol.length){
      var walk=async function(items,d){
        for(var k=0;k<items.length&&out.length<1500;k++){
          var it=items[k],pi=-1;
          try{
            var dest=it.dest;
            if(typeof dest==='string')dest=await pdfDoc.getDestination(dest);
            if(Array.isArray(dest)&&dest[0]!=null)pi=(typeof dest[0]==='object')?await pdfDoc.getPageIndex(dest[0]):dest[0];
          }catch(e){}
          var t=it.title?normStr(it.title).trim():'';
          if(pi>=0&&t)out.push({t:t,pg:pi,d:Math.min(d,3)});
          if(it.items&&it.items.length)await walk(it.items,d+1);
        }
      };
      await walk(ol,0);
    }
  }catch(e){}
  if(out.length>=2&&blocks.length){
    var toc=out.map(function(o){return {t:o.t,bi:firstBlockOfPage(blocks,o.pg),d:o.d}});
    toc.sort(function(a,b){return a.bi-b.bi});
    return toc;
  }
  var hs=[];
  blocks.forEach(function(b,i){if(b.h)hs.push({t:b.t,bi:i,d:b.h-1})});
  if(hs.length>300){var h1=hs.filter(function(x){return x.d===0});return (h1.length>=2&&h1.length<=300)?h1:[]}
  return hs;
}

/* =====================================================================
   State
   ===================================================================== */
var pdf=null, cur=null, B=null, curBi=0, openToken=0, prepCancelled=false;
var mode='page';                 // effective mode: page | scroll | scan
var pager=$('#pager'), flow=$('#flow'), scroller=$('#scroller'), sflow=$('#sflow'), scans=$('#scans');
var sec=-1, page=0, pages=1, step=1, bStart=[], bEnd=[], blockEls=[], flowRtl=true, flipRTL=true;
var sEls=null, jumping=false, barsOn=false, dragging=false, bms=[], scanToken=0, scanObs=null;

/* =====================================================================
   Library
   ===================================================================== */
async function renderLib(){
  var books=await db.all('books');
  books.sort(function(a,b){return (prog(b.id).last||b.added||0)-(prog(a.id).last||a.added||0)});
  var list=$('#list');list.textContent='';
  $('#count').textContent=books.length?(books.length+' كتاب'):'';
  $('#empty').hidden=books.length>0;
  books.forEach(function(b){
    var p=prog(b.id),name=cleanName(b.name);
    var card=el('div','book');card.tabIndex=0;card.setAttribute('role','button');
    var sp=el('div','spine',name.charAt(0));
    sp.style.background='hsl('+(parseInt(hash(b.id),36)%360)+' 34% 34%)';
    var body=el('div');
    body.append(el('h2','',name));
    body.append(el('p','',p.pct!=null?('وصلتي لـ '+p.pct+'%'):'جديد'));
    var tr=el('div','bar-track'),fl=el('div','bar-fill');
    fl.style.width=(p.pct||0)+'%';
    tr.append(fl);body.append(tr);
    var del=el('button','del','حذف');del.type='button';
    var armed=null;
    del.addEventListener('click',async function(e){
      e.stopPropagation();
      if(!armed){del.textContent='تأكيد؟';del.classList.add('sure');armed=setTimeout(function(){armed=null;del.textContent='حذف';del.classList.remove('sure')},3000);return}
      clearTimeout(armed);
      await db.del('books',b.id);await db.del('texts',b.id);
      lsDel('qari.p.'+b.id);lsDel('qari.bm.'+b.id);
      renderLib();
    });
    card.append(sp,body,del);
    card.addEventListener('click',function(){openBook(b.id,b.blob)});
    card.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openBook(b.id,b.blob)}});
    list.append(card);
  });
}

$('#file').addEventListener('change',async function(e){
  var f=e.target.files&&e.target.files[0];e.target.value='';
  if(!f)return;
  if(!/pdf$/i.test(f.name)&&f.type!=='application/pdf'){toast('اختار ملف PDF');return}
  if(f.size>300*1024*1024){toast('الملف كبير بزاف');return}
  var id=hash(f.name+'|'+f.size+'|'+f.lastModified);
  loading(true);
  var ok=true;
  try{
    var ex=await db.get('books',id);
    if(!ex)ok=await db.put('books',{id:id,name:f.name,size:f.size,added:Date.now(),blob:f});
  }catch(err){ok=false}
  loading(false);
  if(!ok)toast('ما قدرتش نحفظ الكتاب، غادي يبقى مفتوح غير ف هاد الجلسة');
  openBook(id,f);
});

/* =====================================================================
   Opening a book
   ===================================================================== */
function showPrep(on){$('#prep').hidden=!on;if(on){$('#prep-fill').style.width='0%';$('#prep-txt').textContent='كننسخ النص ونرتّبو'}}
$('#prep-cancel').addEventListener('click',function(){prepCancelled=true});

function makeSecs(blocks){
  var secs=[],a=0,acc=0;
  for(var i=0;i<blocks.length;i++){
    var L=blocks[i].t.length;
    if(i>a&&((blocks[i].h===1&&acc>2500)||acc+L>9000)){secs.push({a:a,b:i});a=i;acc=0}
    acc+=L;
  }
  if(a<blocks.length)secs.push({a:a,b:blocks.length});
  return secs;
}
function setupBook(rec){
  var blocks=rec.blocks,n=blocks.length,cum=new Float64Array(n+1);
  for(var i=0;i<n;i++)cum[i+1]=cum[i]+blocks[i].t.length;
  B={blocks:blocks,toc:rec.toc||[],rtl:!!rec.rtl,scanned:!!rec.scanned,cum:cum,total:cum[n],secs:makeSecs(blocks),numPages:rec.numPages};
}
function secOf(bi){
  var s=B.secs,lo=0,hi=s.length-1;
  while(lo<hi){var m=(lo+hi+1)>>1;if(s[m].a<=bi)lo=m;else hi=m-1}
  return lo;
}
function biAtChar(c){
  var lo=0,hi=B.blocks.length;
  while(lo<hi){var m=(lo+hi)>>1;if(B.cum[m+1]<=c)lo=m+1;else hi=m}
  return Math.min(lo,B.blocks.length-1);
}
function tocIndexAt(bi){
  var t=B.toc,lo=0,hi=t.length;
  while(lo<hi){var m=(lo+hi)>>1;if(t[m].bi<=bi)lo=m+1;else hi=m}
  return lo-1;
}

async function openBook(id,blob){
  if(!window.pdfjsLib){toast('مكتبة PDF ما تحمّلاتش. عاود حمّل الصفحة');return}
  var token=++openToken;prepCancelled=false;
  loading(true);
  try{
    var rec=await db.get('books',id);
    if(!blob&&rec)blob=rec.blob;
    if(!blob)throw new Error('missing');
    var buf=await blob.arrayBuffer();
    if(token!==openToken)return;
    if(pdf){try{await pdf.destroy()}catch(e){}pdf=null}
    pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf),useSystemFonts:true,standardFontDataUrl:libUrl('lib/standard_fonts/'),wasmUrl:libUrl('lib/wasm/')}).promise;
    if(token!==openToken)return;
    cur={id:id,name:cleanName(rec?rec.name:(blob.name||''))};
    var tr=await db.get('texts',id);
    if(!tr||tr.v!==ALGO||tr.numPages!==pdf.numPages){
      loading(false);showPrep(true);
      var pgs=await extractPages(pdf,function(f){
        $('#prep-fill').style.width=Math.round(f*100)+'%';
        $('#prep-txt').textContent='كننسخ النص ونرتّبو… '+Math.round(f*100)+'%';
      },function(){return prepCancelled||token!==openToken});
      var built=buildBlocks(pgs);
      var toc=await buildToc(pdf,built.blocks);
      tr={id:id,v:ALGO,numPages:pdf.numPages,blocks:built.blocks,toc:toc,rtl:built.rtl,scanned:built.scanned};
      if(!tr.scanned)await db.put('texts',tr);
      showPrep(false);
    }
    if(token!==openToken)return;
    setupBook(tr);
    bms=loadBms(id);
    $('#lib').hidden=true;$('#reader').hidden=false;
    $('#title').textContent=cur.name;
    apply();setBars(false);
    var p=prog(id);
    if(B.scanned)await startScans(p.sf||0);
    else await startReading(p.bi||0);
    wake();
    if(!lsGet('qari.hint')){lsSet('qari.hint','1');toast('اضغط وسط الشاشة باش تبان الأدوات')}
  }catch(e){
    showPrep(false);
    if(!(e&&e.message==='cancel'))toast(e&&e.name==='PasswordException'?'الملف محمي بكلمة سر':'ما قدرتش نفتح هاد الملف');
    if($('#reader').hidden)renderLib();
  }finally{loading(false)}
}

function closeBook(){
  closeSheets();unwake();openToken++;
  if(cur&&B&&mode==='scan')setProg(cur.id,{last:Date.now()});
  $('#reader').hidden=true;$('#lib').hidden=false;
  scanToken++;if(scanObs){scanObs.disconnect();scanObs=null}
  scans.textContent='';flow.textContent='';sflow.textContent='';
  blockEls=[];sEls=null;sec=-1;
  renderLib();
}
$('#back').addEventListener('click',closeBook);

/* =====================================================================
   Reader: paged mode (horizontal columns, like a book) and scroll mode
   ===================================================================== */
function showContainers(){
  pager.hidden=mode!=='page';scroller.hidden=mode!=='scroll';scans.hidden=mode!=='scan';
  $('#open-toc').hidden=mode==='scan';$('#bm').hidden=mode==='scan';
}
async function ensureFont(){
  try{
    var f=FONT_FIRST[S.ff]||'Amiri';
    await Promise.race([
      Promise.all([document.fonts.load("22px '"+f+"'",'ابجد abc'),document.fonts.load("700 22px '"+f+"'",'ابجد abc')]),
      new Promise(function(r){setTimeout(r,1500)})
    ]);
  }catch(e){}
}
async function startReading(bi){
  mode=S.mode;showContainers();
  if(mode==='page'){sec=-1;blockEls=[];await layoutPaged(bi)}
  else{await ensureFont();renderScroll();gotoBlock(bi)}
}

function applyDims(){
  var W=pager.clientWidth,H=pager.clientHeight;
  if(!W||!H)return false;
  var pad=S.pad,top=14,fw=Math.max(120,W-2*pad),fh=Math.max(120,H-top-6);
  step=fw+2*pad;
  flow.style.width=fw+'px';flow.style.height=fh+'px';
  flow.style.left=pad+'px';flow.style.top=top+'px';
  flow.style.columnWidth=fw+'px';flow.style.columnGap=(2*pad)+'px';
  flowRtl=flipRTL;flow.dir=flowRtl?'rtl':'ltr';
  return true;
}
function renderSection(si){
  sec=si;var s=B.secs[si];flow.textContent='';blockEls=[];
  var f=document.createDocumentFragment();
  for(var i=s.a;i<s.b;i++){
    var b=B.blocks[i],e=document.createElement(b.h?(b.h===1?'h2':'h3'):'p');
    e.dir='auto';e.textContent=b.t;f.appendChild(e);blockEls.push(e);
  }
  flow.appendChild(f);
}
/* find on which page (column) each block starts and ends */
function measure(){
  flow.style.transition='none';flow.style.transform='none';
  var fr=flow.getBoundingClientRect();
  function idx(r){return Math.max(0,Math.floor(((flowRtl?(fr.right-r.right):(r.left-fr.left))+2)/step))}
  bStart=[];bEnd=[];var max=0;
  blockEls.forEach(function(e){
    var rs=e.getClientRects();
    if(!rs.length){bStart.push(max);bEnd.push(max);return}
    var a=idx(rs[0]),z=idx(rs[rs.length-1]);
    bStart.push(a);bEnd.push(z);if(z>max)max=z;
  });
  pages=max+1;
}
function posBlock(p){
  var lo=0,hi=bStart.length;
  while(lo<hi){var m=(lo+hi)>>1;if(bStart[m]>=p)hi=m;else lo=m+1}
  if(lo<bStart.length&&bStart[lo]===p)return lo;
  return Math.max(0,lo-1);
}
function lastOnPage(p){
  var lo=0,hi=bStart.length;
  while(lo<hi){var m=(lo+hi)>>1;if(bStart[m]<=p)lo=m+1;else hi=m}
  return Math.max(0,lo-1);
}
function pageOfBlock(bi){return bStart[bi-B.secs[sec].a]||0}
async function layoutPaged(bi){
  if(!B||B.scanned)return;
  await ensureFont();
  if(!applyDims())return;
  var si=secOf(bi);
  if(si!==sec||!blockEls.length)renderSection(si);
  measure();
  showPage(pageOfBlock(bi),false);
}
function showPage(p,anim){
  page=clamp(p,0,pages-1);
  var x=(flowRtl?1:-1)*page*step;
  flow.style.transition=(anim&&!reduced)?'transform .18s ease':'none';
  flow.style.transform='translate3d('+x+'px,0,0)';
  curBi=B.secs[sec].a+posBlock(page);
  updateStatus(0);
}

function renderScroll(){
  sflow.textContent='';sEls=[];
  var f=document.createDocumentFragment();
  B.blocks.forEach(function(b){
    var e=document.createElement(b.h?(b.h===1?'h2':'h3'):'p');
    e.dir='auto';e.textContent=b.t;f.appendChild(e);sEls.push(e);
  });
  sflow.appendChild(f);
}
var scrollQueued=false;
scroller.addEventListener('scroll',function(){
  if(scrollQueued)return;scrollQueued=true;
  requestAnimationFrame(function(){scrollQueued=false;onScroll()});
},{passive:true});
function firstVisible(){
  var y=scroller.scrollTop+16,lo=0,hi=sEls.length-1;
  while(lo<hi){var m=(lo+hi)>>1,e=sEls[m];if(e.offsetTop+e.offsetHeight>y)hi=m;else lo=m+1}
  return lo;
}
function onScroll(){
  if(jumping||mode!=='scroll'||!sEls)return;
  var i=firstVisible(),e=sEls[i],y=scroller.scrollTop+16;
  curBi=i;
  updateStatus(clamp((y-e.offsetTop)/Math.max(1,e.offsetHeight),0,1));
}

function gotoBlock(bi,anim){
  if(!B||B.scanned)return;
  bi=clamp(bi|0,0,B.blocks.length-1);
  if(mode==='scroll'){
    var e=sEls[bi];jumping=true;
    scroller.scrollTop=Math.max(0,e.offsetTop-12);
    curBi=bi;
    requestAnimationFrame(function(){jumping=false;onScroll()});
    return;
  }
  var si=secOf(bi);
  if(si!==sec){renderSection(si);measure()}
  showPage(pageOfBlock(bi),anim);
}

/* ---------- status line, progress, bookmarks state ---------- */
function atEnd(){
  if(mode==='page')return sec===B.secs.length-1&&page===pages-1;
  if(mode==='scroll'){var e=sEls[sEls.length-1];return e.offsetTop+e.offsetHeight<=scroller.scrollTop+scroller.clientHeight+4}
  return false;
}
function visibleRange(){
  if(mode==='page')return [curBi,B.secs[sec].a+lastOnPage(page)];
  var y=scroller.scrollTop+scroller.clientHeight,lo=curBi,hi=curBi;
  while(hi+1<sEls.length&&sEls[hi+1].offsetTop<y)hi++;
  return [lo,hi];
}
function isBookmarked(){
  var r=visibleRange();
  return bms.some(function(b){return b.bi>=r[0]&&b.bi<=r[1]});
}
function updateStatus(frac){
  var n=B.blocks[curBi].t.length;
  var pct=B.total?(B.cum[curBi]+(frac||0)*n)/B.total*100:0;
  pct=clamp(pct,0,100);
  var shown=atEnd()?100:Math.floor(pct);
  $('#f-pct').textContent=shown+'%';
  $('#sl-pct').textContent=shown+'%';
  if(!dragging)$('#slider').value=Math.round(pct*10);
  var ti=tocIndexAt(curBi);
  $('#f-title').textContent=ti>=0?B.toc[ti].t:cur.name;
  $('#bm').setAttribute('aria-pressed',isBookmarked()?'true':'false');
  setProg(cur.id,{bi:curBi,pct:shown,last:Date.now()});
}

/* ---------- turning pages ---------- */
function turn(d){
  if(!B||B.scanned)return;
  if(barsOn)setBars(false);
  if(mode==='scroll'){
    scroller.scrollBy({top:d*scroller.clientHeight*0.9,behavior:reduced?'auto':'smooth'});
    return;
  }
  var np=page+d;
  if(np>=0&&np<pages){showPage(np,true);return}
  if(d>0){
    if(sec<B.secs.length-1){renderSection(sec+1);measure();showPage(0,false)}
    else toast('وصلتي لنهاية الكتاب');
  }else{
    if(sec>0){renderSection(sec-1);measure();showPage(pages-1,false)}
    else toast('هادي بداية الكتاب');
  }
}
$('#prev').addEventListener('click',function(){turn(-1)});
$('#next').addEventListener('click',function(){turn(1)});
$('#slider').addEventListener('input',function(){dragging=true;$('#sl-pct').textContent=Math.round(this.value/10)+'%'});
$('#slider').addEventListener('change',function(){
  dragging=false;
  if(!B||B.scanned)return;
  gotoBlock(biAtChar(this.value/1000*B.total),false);
});

function setBars(on){
  barsOn=on;
  $('#top').hidden=!on;
  $('#bottom').hidden=!(on&&mode!=='scan');
}
$('#reader').addEventListener('click',function(e){
  if(e.target.closest('.bar,.sheet,#scrim'))return;
  if(String(window.getSelection&&window.getSelection()).length)return;
  if(mode!=='page'){setBars(!barsOn);return}
  var r=$('#reader').getBoundingClientRect(),x=(e.clientX-r.left)/r.width;
  if(x<0.28)turn(flipRTL?1:-1);
  else if(x>0.72)turn(flipRTL?-1:1);
  else setBars(!barsOn);
});
var sx=null,sy=0,st=0;
$('#reader').addEventListener('touchstart',function(e){
  if(e.touches.length!==1||mode!=='page'){sx=null;return}
  var t=e.touches[0];sx=t.clientX;sy=t.clientY;st=Date.now();
},{passive:true});
$('#reader').addEventListener('touchend',function(e){
  if(sx===null)return;
  var t=e.changedTouches[0],dx=t.clientX-sx,dy=t.clientY-sy;sx=null;
  if(Math.abs(dx)>60&&Math.abs(dy)<50&&Date.now()-st<600)turn((dx>0)===flipRTL?1:-1);
},{passive:true});
document.addEventListener('keydown',function(e){
  if($('#reader').hidden||!B)return;
  var t=e.target&&e.target.tagName;if(t==='INPUT'&&e.target.type!=='range')return;
  if(e.key==='ArrowLeft')turn(flipRTL?1:-1);
  else if(e.key==='ArrowRight')turn(flipRTL?-1:1);
  else if(e.key==='PageDown'||e.key===' ')turn(1);
  else if(e.key==='PageUp')turn(-1);
});

/* =====================================================================
   Scanned books (no text): pages are shown as images, loaded lazily
   ===================================================================== */
async function startScans(sf){
  mode='scan';showContainers();apply();
  var token=++scanToken;
  scans.textContent='';
  scans.append(el('div','msg','هاد الكتاب مصوّر (صفحاته صور بلا نص)، ما قدرتش ننسخ منو نص. كنعرض ليك الصفحات كصور. الفهرس والعلامات وإعدادات الخط ما خدامينش معاه.'));
  var p1=await pdf.getPage(1),v1=p1.getViewport({scale:1}),ratio=v1.height/v1.width;
  var w=Math.max(200,Math.min(scans.clientWidth-24,900)),wraps=[];
  for(var i=0;i<pdf.numPages;i++){
    var d=el('div','pg');d.dataset.i=i;d.style.width=w+'px';d.style.height=Math.round(w*ratio)+'px';
    scans.append(d);wraps.push(d);
  }
  if(scanObs)scanObs.disconnect();
  scanObs=new IntersectionObserver(function(es){
    es.forEach(function(en){
      var d=en.target;
      if(en.isIntersecting)renderScan(d,token);
      else{d.textContent='';delete d.dataset.r}
    });
  },{root:scans,rootMargin:'150% 0px'});
  wraps.forEach(function(d){scanObs.observe(d)});
  if(sf)setTimeout(function(){scans.scrollTop=sf*(scans.scrollHeight-scans.clientHeight)},60);
}
async function renderScan(d,token){
  if(d.dataset.r)return;
  d.dataset.r='1';
  try{
    var pg=await pdf.getPage(+d.dataset.i+1);
    if(token!==scanToken||!d.dataset.r)return;
    var w=d.clientWidth,v0=pg.getViewport({scale:1}),dpr=Math.min(window.devicePixelRatio||1,2.5);
    var vp=pg.getViewport({scale:w/v0.width*dpr});
    var c=document.createElement('canvas');c.width=Math.floor(vp.width);c.height=Math.floor(vp.height);
    d.style.height=Math.round(w*v0.height/v0.width)+'px';
    await pg.render({canvas:c,canvasContext:c.getContext('2d'),viewport:vp}).promise;
    if(token!==scanToken||!d.dataset.r)return;
    d.textContent='';d.append(c);
  }catch(e){}
}
scans.addEventListener('scroll',debounce(function(){
  if(mode!=='scan'||!cur)return;
  var max=scans.scrollHeight-scans.clientHeight,f=max>0?scans.scrollTop/max:0;
  setProg(cur.id,{sf:f,pct:Math.round(f*100),last:Date.now()});
  $('#f-pct').textContent=Math.round(f*100)+'%';
},200),{passive:true});

/* =====================================================================
   Contents and bookmarks
   ===================================================================== */
var tab='toc';
function pctOf(bi){return B.total?Math.floor(B.cum[bi]/B.total*100):0}
function renderTab(){
  var list=$('#t-list');list.textContent='';
  $('#t-toc').setAttribute('aria-pressed',tab==='toc'?'true':'false');
  $('#t-bm').setAttribute('aria-pressed',tab==='bm'?'true':'false');
  if(!B)return;
  if(tab==='toc'){
    if(!B.toc.length){list.append(el('div','tempty','ما لقيتش فهرس ولا عناوين ف هاد الكتاب. تقدر تستعمل شريط التنقل ف الأسفل.'));return}
    var now=tocIndexAt(curBi),nowEl=null;
    B.toc.forEach(function(t,i){
      var b=el('button','it'+(i===now?' now':''));b.type='button';
      b.style.paddingInlineStart=(8+t.d*18)+'px';
      b.append(el('span','t',t.t),el('span','p',pctOf(t.bi)+'%'));
      b.addEventListener('click',function(){closeSheets();setBars(false);gotoBlock(t.bi,false)});
      list.append(b);if(i===now)nowEl=b;
    });
    if(nowEl)setTimeout(function(){list.scrollTop=Math.max(0,nowEl.offsetTop-list.clientHeight/3)},0);
  }else{
    if(!bms.length){list.append(el('div','tempty','ما عندك حتى علامة. ضغط على أيقونة العلامة ف الشريط الفوقاني باش تحفظ الصفحة لي نتا فيها.'));return}
    bms.forEach(function(m){
      var row=el('div','it');
      var go=el('button','t');go.type='button';go.style.cssText='flex:1;min-width:0;text-align:start;background:none';
      go.textContent=m.t;
      go.addEventListener('click',function(){closeSheets();setBars(false);gotoBlock(m.bi,false)});
      var x=el('button','x','✕');x.type='button';x.setAttribute('aria-label','حيّد العلامة');
      x.addEventListener('click',function(){bms=bms.filter(function(b){return b!==m});saveBms(cur.id,bms);renderTab();$('#bm').setAttribute('aria-pressed',isBookmarked()?'true':'false')});
      row.append(go,el('span','p',m.pct+'%'),x);
      list.append(row);
    });
  }
}
$('#t-toc').addEventListener('click',function(){tab='toc';renderTab()});
$('#t-bm').addEventListener('click',function(){tab='bm';renderTab()});
$('#open-toc').addEventListener('click',function(){tab='toc';renderTab();openSheet('tsheet')});
$('#close-t').addEventListener('click',closeSheets);
$('#bm').addEventListener('click',function(){
  if(!B||B.scanned)return;
  var r=visibleRange();
  var inR=function(b){return b.bi>=r[0]&&b.bi<=r[1]};
  if(bms.some(inR)){bms=bms.filter(function(b){return !inR(b)});toast('تحيّدات العلامة')}
  else{
    bms.push({bi:curBi,t:B.blocks[curBi].t.slice(0,80),pct:pctOf(curBi),ts:Date.now()});
    bms.sort(function(a,b){return a.bi-b.bi});toast('تزادت علامة مرجعية');
  }
  saveBms(cur.id,bms);
  $('#bm').setAttribute('aria-pressed',isBookmarked()?'true':'false');
});

/* =====================================================================
   Settings
   ===================================================================== */
function makeChips(id,items,onPick){
  var box=$(id);
  items.forEach(function(it){
    var b=el('button','chip',it[1]);b.type='button';b.dataset.v=String(it[0]);
    if(id==='#c-ff')b.style.fontFamily=FONTS[it[0]];
    b.addEventListener('click',function(){onPick(it[0]);apply();save()});
    box.append(b);
  });
}
function chipsState(id,val){
  $(id).querySelectorAll('.chip').forEach(function(b){b.setAttribute('aria-pressed',b.dataset.v===String(val)?'true':'false')});
}
var relayout=debounce(async function(){
  if(!B||B.scanned||$('#reader').hidden||mode==='scan')return;
  var bi=curBi;
  await ensureFont();
  if(mode==='page'){if(!applyDims())return;measure();showPage(pageOfBlock(bi),false)}
  else gotoBlock(bi);
},120);
async function switchMode(){
  if(!B||B.scanned)return;
  var bi=curBi;mode=S.mode;showContainers();apply();
  if(mode==='page'){sec=-1;blockEls=[];await layoutPaged(bi)}
  else{if(!sEls)renderScroll();await ensureFont();gotoBlock(bi)}
  setBars(barsOn);
}
makeChips('#c-mode',[['page','صفحات'],['scroll','تمرير']],function(v){S.mode=v;switchMode()});
makeChips('#c-ff',Object.keys(FONT_LABELS).map(function(k){return [k,FONT_LABELS[k]]}),function(v){S.ff=v;relayout()});
makeChips('#c-just',[['1','ضبط'],['0','عادية']],function(v){S.just=(v==='1');relayout()});
makeChips('#c-flip',[['auto','تلقائي'],['rtl','من اليمين'],['ltr','من اليسار']],function(v){S.flip=v;apply();relayout()});
THEMES.forEach(function(t){
  var b=el('button','sw');b.type='button';b.dataset.v=t[0];
  var i=el('i','','أب');i.style.background=t[2];i.style.color=t[3];
  b.append(i,el('span','',t[1]));
  b.addEventListener('click',function(){S.theme=t[0];apply();save()});
  $('#themes').append(b);
});
function bindRange(id,key,after){
  $(id).addEventListener('input',function(){S[key]=+this.value;apply();save();if(after)after()});
}
bindRange('#r-bright','bright');
bindRange('#r-warm','warm');
bindRange('#r-fs','fs',relayout);
bindRange('#r-lh','lh',relayout);
bindRange('#r-pad','pad',relayout);
$('#k-awake').addEventListener('change',function(){S.awake=this.checked;save();if(S.awake)wake();else unwake()});

function apply(){
  var R=$('#reader');
  R.dataset.rt=S.theme;
  R.style.setProperty('--fs',S.fs+'px');
  R.style.setProperty('--lh',String(S.lh));
  R.style.setProperty('--pad',S.pad+'px');
  R.style.setProperty('--ff',FONTS[S.ff]||FONTS.amiri);
  R.style.setProperty('--ta',S.just?'justify':'start');
  flipRTL=S.flip==='rtl'?true:(S.flip==='ltr'?false:(B?B.rtl:true));
  $('#bottom').dir=flipRTL?'rtl':'ltr';
  $('#dim').style.opacity=String(1-S.bright/100);
  $('#warm').style.opacity=String(S.warm/100*0.5);
  var scan=mode==='scan';
  $('#g-text').hidden=scan;$('#g-size').hidden=scan;$('#g-just').hidden=scan;
  $('#r-bright').value=S.bright;$('#o-bright').textContent=S.bright+'%';
  $('#r-warm').value=S.warm;$('#o-warm').textContent=S.warm+'%';
  $('#r-fs').value=S.fs;$('#o-fs').textContent=S.fs;
  $('#r-lh').value=S.lh;$('#o-lh').textContent=(+S.lh).toFixed(1);
  $('#r-pad').value=S.pad;$('#o-pad').textContent=S.pad;
  chipsState('#c-mode',S.mode);chipsState('#c-ff',S.ff);chipsState('#c-just',S.just?'1':'0');chipsState('#c-flip',S.flip);
  $('#themes').querySelectorAll('.sw').forEach(function(b){b.setAttribute('aria-pressed',b.dataset.v===S.theme?'true':'false')});
  $('#k-awake').checked=!!S.awake;
}

function openSheet(id){$('#scrim').hidden=false;$('#'+id).hidden=false}
function closeSheets(){$('#scrim').hidden=true;$('#sheet').hidden=true;$('#tsheet').hidden=true}
$('#open-set').addEventListener('click',function(){openSheet('sheet')});
$('#close-set').addEventListener('click',closeSheets);
$('#scrim').addEventListener('click',closeSheets);

/* ---------- keep the screen awake while reading ---------- */
var wl=null;
async function wake(){
  try{
    if(S.awake&&navigator.wakeLock&&!document.hidden&&!$('#reader').hidden&&!wl){
      wl=await navigator.wakeLock.request('screen');
      wl.addEventListener('release',function(){wl=null});
    }
  }catch(e){wl=null}
}
function unwake(){try{if(wl)wl.release()}catch(e){}wl=null}
document.addEventListener('visibilitychange',function(){if(!document.hidden)wake()});
window.addEventListener('resize',relayout);
try{document.fonts.addEventListener('loadingdone',relayout)}catch(e){}
window.addEventListener('pagehide',function(){if(cur&&B&&!$('#reader').hidden)setProg(cur.id,{last:Date.now()})});

/* ---------- start ---------- */
apply();
openDB().then(function(d){idb=d;return renderLib()});
try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist()}catch(e){}
if('serviceWorker' in navigator){
  window.addEventListener('load',function(){navigator.serviceWorker.register('sw.js').catch(function(){})});
}
})();
