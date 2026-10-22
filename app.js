// TRPG日程調整 — Firebase版
// PLはログイン不要で回答、GMはGoogleログインで卓・候補日を管理します。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, collection, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, query, where, writeBatch, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ---------- 共通 ----------
const WD = ["日","月","火","水","木","金","土"];
const OPTS = ["all","day","night","x"];
const MARK = {all:"全日",day:"昼",night:"夜",x:"✖"};
const SHORT = {all:"全",day:"昼",night:"夜",x:"✖"};
const DESC = {all:"一日中参加できる",day:"昼なら参加できる",night:"夜なら参加できる",x:"参加できない"};
const ST = {adjusting:"調整中",decided:"日程決定",done:"終了"};
const $ = id => document.getElementById(id);
const tid = new URLSearchParams(location.search).get("t");

const S = { user:null, isGM:false, gmChecked:false, authReady:false,
  meta:{}, tableExists:null, dates:[], players:[], editingId:null, draft:{answers:{}}, metaDirty:false,
  tables:[], filter:"active", editTableId:null };
try{ const f=localStorage.getItem("taku.filter"); if(f) S.filter=f; }catch(_){}
try{ S.scope=localStorage.getItem("taku.scope")==="all" ? "all" : "mine"; }catch(_){ S.scope="mine"; }

function el(tag, attrs, ...kids){
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs){
    if (k === "class") e.className = attrs[k];
    else if (k === "text") e.textContent = attrs[k];
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
let toastT;
function toast(msg){
  const t=$("toast"); const open=[...document.querySelectorAll("dialog")].find(d=>d.open);
  (open||document.body).append(t); t.textContent=msg; t.hidden=false;
  clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true,2600);
}
function setStatus(msg, kind){ const s=$("status"); if(!msg){s.hidden=true;return;} s.hidden=false; s.textContent=msg; if(kind) s.dataset.kind=kind; else delete s.dataset.kind; }
function fail(e){
  const code=e&&e.code;
  if (code==="permission-denied") toast("保存できませんでした（権限がありません）");
  else if (code==="unavailable"||code==="resource-exhausted") toast("混み合っています。少し待ってからもう一度押してください");
  else toast("保存できませんでした（"+(code||"不明なエラー")+"）");
  console.error(e);
}
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
function parseDate(str){ const [y,m,d]=(str||"").split("-").map(Number); return y? new Date(y,m-1,d) : null; }
function fmtDate(str){ const d=parseDate(str); return d ? `${d.getMonth()+1}/${d.getDate()}(${WD[d.getDay()]})` : str; }
function fmtFull(str){ const d=parseDate(str); return d ? `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}(${WD[d.getDay()]})` : ""; }
function dateLabel(dt){ return fmtDate(dt.date) + (dt.time ? " " + dt.time + "〜" : ""); }
function tableLink(id){ return location.origin + location.pathname + "?t=" + encodeURIComponent(id); }
async function copyText(text, okMsg){
  try{ await navigator.clipboard.writeText(text); toast(okMsg||"コピーしました"); return true; }
  catch(_){ toast("コピーできませんでした。表示された文字を長押しでコピーしてください"); return false; }
}
function openDlg(d){ if(!d.open){ try{ d.showModal(); }catch(_){ d.setAttribute("open",""); } } }
function closeDlg(d){ if(d.open){ try{ d.close(); }catch(_){ d.removeAttribute("open"); d.dispatchEvent(new Event("close")); } } }
function confirmDel(msg, sub){
  const d=$("confirm-dlg");
  $("c-msg").textContent=msg; $("c-sub").textContent=sub||""; $("c-sub").hidden=!sub;
  return new Promise(res=>{
    let ok=false;
    const done=()=>{ d.removeEventListener("close",onClose); $("c-ok").onclick=null; $("c-cancel").onclick=null; res(ok); };
    const onClose=()=>done();
    d.addEventListener("close",onClose);
    $("c-ok").onclick=()=>{ ok=true; closeDlg(d); };
    $("c-cancel").onclick=()=>closeDlg(d);
    openDlg(d);
  });
}
document.querySelectorAll("dialog").forEach(d=>d.addEventListener("click",e=>{ if(e.target===d) closeDlg(d); }));

// ---------- GMログイン ----------
function renderAuth(){
  const box=$("auth"); box.replaceChildren();
  if (!S.user){
    box.append(el("button",{class:"link-btn",type:"button",onclick:login},"GMとしてログイン"));
  } else {
    box.append(...[el("span",{text: S.isGM ? (S.isAdmin ? "管理者としてログイン中" : "GMとしてログイン中") : (S.gmChecked ? "このアカウントはGMとして登録されていません" : "確認中…")}),
      S.isGM && tid ? el("a",{class:"link-btn",href:location.pathname},"卓一覧へ") : null,
      el("button",{class:"link-btn",type:"button",onclick:()=>signOut(auth)},"ログアウト")].filter(Boolean));
  }
}
// 作成から180日たった卓は、GMが卓一覧を開いたときにアプリが削除する（TTLは課金必須のため使わない）
const RETENTION_DAYS=180;
const newExpiry=()=>Timestamp.fromMillis(Date.now()+RETENTION_DAYS*86400000);
const canManage=()=>!!(S.isGM && S.user && (S.isAdmin || (S.meta && S.meta.ownerUid===S.user.uid)));

async function login(){
  try{ await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch(e){ if(e.code!=="auth/popup-closed-by-user" && e.code!=="auth/cancelled-popup-request") toast("ログインできませんでした（"+e.code+"）"); }
}
onAuthStateChanged(auth, async user=>{
  S.user=user; S.isGM=false; S.isAdmin=false; S.gmChecked=false; S.authReady=true; renderAuth();
  if (user){
    try{
      const g=user.email ? await getDoc(doc(db,"gms",user.email.toLowerCase())) : null;
      S.isGM=!!g && g.exists(); S.isAdmin=S.isGM && g.data().admin===true;
    }
    catch(_){ S.isGM=false; }
    S.gmChecked=true;
  }
  renderAuth();
  if (tid) applyGM(); else bootList();
});

// =========================================================
// 卓ページ（?t=卓ID）
// =========================================================
function tally(dates, players){
  return dates.map(dt=>{
    let all=0,day=0,night=0,x=0;
    for (const p of players){ const v=ans(p,dt.id); if(v==="all")all++; else if(v==="day")day++; else if(v==="night")night++; else if(v==="x")x++; }
    const d=all+day, n=all+night;
    return {dt,all,day,night,x,d,n,score:Math.max(d,n)};
  });
}
function ans(p,id){ const v=(p.answers||{})[id]; return MARK[v] ? v : undefined; }
function sortedDates(){ return S.dates.slice().sort((a,b)=> (a.date+(a.time||"")).localeCompare(b.date+(b.time||""))); }
function sortedPlayers(){ return S.players.slice().sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)); }

function renderHeader(){
  const m=S.meta;
  $("title").textContent = m.title || "TRPG日程調整";
  document.title = (m.title || "TRPG日程調整");
  $("m-scenario").textContent = m.scenario || "未設定";
  $("m-count").textContent = S.players.length + "人";
  const n=$("m-note"); n.textContent = m.note || ""; n.hidden = !m.note;
}

let bMonth=null, bSel=null;
function slotStatus(r,P){
  const st=(ok,ng)=> ok===P ? "all" : (ng===0 && ok>0 ? "nox" : null);
  return { day:st(r.all+r.day, r.x+r.night), night:st(r.all+r.night, r.x+r.day) };
}
const RANK={all:2,nox:1};
function tagsFor(st){
  if (st.day && st.day===st.night) return [{label:"終日",cls:"full",kind:st.day}];
  const out=[];
  if (st.day) out.push({label:"昼",cls:"day",kind:st.day});
  if (st.night) out.push({label:"夜",cls:"night",kind:st.night});
  return out;
}
const tagEl=t=>el("span",{class:`tag ${t.cls} ${t.kind}`,text:t.label});

function renderBest(){
  const box=$("best"); box.replaceChildren();
  const P=S.players.length, rows=tally(sortedDates(), S.players);
  if (!S.dates.length){ box.append(el("p",{class:"empty",text:"候補日がまだありません。"})); return; }
  const byDate=new Map();
  for (const r of rows){
    const st = P ? slotStatus(r,P) : {day:null,night:null};
    const cur=byDate.get(r.dt.date) || {day:null,night:null,rows:[]};
    for (const k of ["day","night"]) if ((RANK[st[k]]||0) > (RANK[cur[k]]||0)) cur[k]=st[k];
    cur.rows.push({r,st}); byDate.set(r.dt.date,cur);
  }
  const keys=[...byDate.keys()].sort();
  const ym=str=>{ const d=parseDate(str); return new Date(d.getFullYear(), d.getMonth(), 1); };
  const minM=ym(keys[0]), maxM=ym(keys[keys.length-1]);
  if (!bMonth || bMonth<minM || bMonth>maxM) bMonth=minM;
  if (bSel && !byDate.has(bSel)) bSel=null;

  let nAll=0,nNox=0;
  for (const v of byDate.values()){ const k=[v.day,v.night]; if(k.includes("all")) nAll++; else if(k.includes("nox")) nNox++; }
  box.append(el("div",{class:"bsum"},
    el("span",null,"全員OK ",el("b",{text:nAll}),"日"),
    el("span",null,"✖の人がいない ",el("b",{text:nNox}),"日"),
    P ? null : el("span",{text:"（まだ回答がありません）"})));

  const y=bMonth.getFullYear(), m=bMonth.getMonth();
  const prev=el("button",{class:"cal-nav",type:"button","aria-label":"前の月",text:"‹",disabled: bMonth<=minM?"":null,
    onclick:()=>{ bMonth=new Date(y,m-1,1); renderBest(); }});
  const next=el("button",{class:"cal-nav",type:"button","aria-label":"次の月",text:"›",disabled: bMonth>=maxM?"":null,
    onclick:()=>{ bMonth=new Date(y,m+1,1); renderBest(); }});
  const g=el("div",{class:"bgrid"});
  WD.forEach((w,i)=>g.append(el("span",{class:"cal-wd"+(i===0?" sun":""),text:w,"aria-hidden":"true"})));
  const lead=new Date(y,m,1).getDay(); for(let i=0;i<lead;i++) g.append(el("span"));
  const days=new Date(y,m+1,0).getDate();
  for (let d=1; d<=days; d++){
    const dt=new Date(y,m,d), ds=iso(dt), info=byDate.get(ds), sun=dt.getDay()===0?" sun":"";
    if (!info){ g.append(el("div",{class:"bday"+sun}, el("span",{class:"bnum",text:String(d)}))); continue; }
    const tags=tagsFor(info);
    g.append(el("button",{type:"button",class:"bday cand"+sun,"aria-pressed":String(bSel===ds),
      "aria-label":fmtDate(ds)+(tags.length? "："+tags.map(t=>t.label+(t.kind==="all"?"は全員OK":"は✖なし")).join("、") : ""),
      onclick:()=>{ bSel = bSel===ds ? null : ds; renderBest(); }},
      el("span",{class:"bnum",text:String(d)}), tags.map(tagEl)));
  }
  box.append(el("div",{class:"bcal"}, el("div",{class:"cal-head"}, prev, el("span",{text:`${y}年${m+1}月`}), next), g));
  box.append(el("div",{class:"blegend"},
    el("span",null, tagEl({label:"終日",cls:"full",kind:"all"}), tagEl({label:"昼",cls:"day",kind:"all"}), tagEl({label:"夜",cls:"night",kind:"all"}), "全員OK"),
    el("span",null, tagEl({label:"夜",cls:"night",kind:"nox"}), "✖の人がいない（未回答あり）"),
    el("span",{text:"日付をタップで内訳"})));

  if (bSel){
    const info=byDate.get(bSel);
    const det=el("div",{class:"bdetail"});
    for (const {r,st} of info.rows){
      det.append(el("div",{class:"t",text:dateLabel(r.dt)+(r.dt.note?"　"+r.dt.note:"")}));
      det.append(el("div",{class:"r"},
        el("span",{text:`昼OK ${r.all+r.day}/${P}`}), el("span",{text:`夜OK ${r.all+r.night}/${P}`}),
        el("span",{text:`✖ ${r.x}`}), el("span",{text:`未回答 ${P-(r.all+r.day+r.night+r.x)}`}),
        tagsFor(st).map(tagEl)));
      const list=el("div",{class:"who"});
      for (const [v,label] of [["all","全日"],["day","昼"],["night","夜"],["x","✖"],[null,"未回答"]]){
        const ps=sortedPlayers().filter(p=>ans(p,r.dt.id)===(v||undefined));
        if (!ps.length) continue;
        list.append(el("div",{class:"who-row"}, el("span",{class:"mark "+(v||"n"),text:label}),
          el("span",{class:"who-names",text:ps.map(p=>p.name||"名無し").join("、")})));
      }
      if (list.childNodes.length) det.append(list);
    }
    box.append(det);
  }
}

// ---- 卓予定時間の重なり（全日／昼／夜ごと、全員が重なる時間だけを文字で表示） ----
// 本人が卓予定時間を入れていなければ、GMの初期値（なければ既定値）を使う。
function slotOf(p, k){
  const base=(S.meta&&S.meta.slotDefaults) || DEFAULT_SLOTS;
  const r=((p.slots||{})[k]) || base[k];
  return (Array.isArray(r)&&r[0]<r[1]) ? r : null;
}
// 全日・昼は、卓の途中に休憩をはさむものとして、可能時間から差し引く（時間）
const BREAK_H={all:3, day:1, night:0};
function renderOverlap(){
  const panel=$("ov-panel"), box=$("ov");
  const players=sortedPlayers();
  panel.hidden = !players.length;
  if (panel.hidden) return;
  box.replaceChildren();
  for (const k of SLOT_KINDS){
    // 全員の範囲が重なる時間（共通部分）
    const rs=players.map(p=>slotOf(p,k));
    let text="重なる時間なし";
    if (rs.every(Boolean)){
      const s=Math.max(...rs.map(r=>r[0])), e=Math.min(...rs.map(r=>r[1]));
      if (s<e){
        const hrs=n=>String(Math.round(n*10)/10);
        const total=(e-s)/60, br=BREAK_H[k];
        text=`${fmtMin(s)}〜${fmtMin(e)}（${hrs(Math.max(0,total-br))}時間${br ? `　※休憩${br}時間を除く` : ""}）`;
      }
    }    box.append(el("div",{class:"ov-row "+k}, el("span",{class:"ov-k",text:MARK[k]}), el("span",{class:"ov-v",text})));
  }
}
function renderGrid(){
  const box=$("grid"); box.replaceChildren();
  const dates=sortedDates(), players=sortedPlayers();
  if (!dates.length){ box.append(el("p",{class:"empty",text:"候補日がまだありません。GMが候補日を追加すると、ここに表が出ます。"})); return; }
  const rows=tally(dates,players);
  const head=el("tr",null, el("th",{class:"date",scope:"col",text:"候補日"}),
    el("th",{scope:"col",title:"昼に参加できる人（全日＋昼）",text:"昼OK"}), el("th",{scope:"col",title:"夜に参加できる人（全日＋夜）",text:"夜OK"}), el("th",{scope:"col",text:"✖"}),
    players.map(p=>el("th",{scope:"col"}, el("button",{class:"pl",type:"button",title:"この人の回答を編集",onclick:()=>startEdit(p.id)}, p.name||"名無し"))));
  const body=el("tbody");
  for (const r of rows){
    body.append(el("tr",{class: (players.length && r.score===players.length) ? "top" : null},
      el("th",{class:"date",scope:"row"}, fmtDate(r.dt.date), r.dt.time? el("span",{class:"d-time",text:r.dt.time+"〜"}):null, r.dt.note? el("span",{class:"d-note",text:r.dt.note}):null),
      el("td",{class:"cnt day",text:r.d}), el("td",{class:"cnt night",text:r.n}), el("td",{class:"cnt x",text:r.x}),
      players.map(p=>{ const v=ans(p,r.dt.id); return el("td",null, el("span",{class:"mark "+(v||"n"),"aria-label":v?DESC[v]:"未回答",title:v?MARK[v]:"未回答",text:v?SHORT[v]:"–"})); })));
  }
  if (players.some(p=>slotsText(p.slots))){
    body.append(el("tr",{class:"slotrow"}, el("th",{class:"date",scope:"row",text:"卓予定時間"}), el("td",{colspan:3}),
      players.map(p=>el("td",null, ...SLOT_KINDS.filter(k=>(p.slots||{})[k]).map(k=>el("div",{class:"sl "+k},
        el("b",{text:MARK[k]}), " "+slotRange(p.slots[k])))))));
  }
  if (players.some(p=>p.comment)){
    body.append(el("tr",{class:"comments"}, el("th",{class:"date",scope:"row",text:"コメント"}), el("td",{colspan:3}),
      players.map(p=>el("td",null, p.comment ? el("div",{class:"cm",text:p.comment}) : null))));
  }
  box.append(el("table",null, el("thead",null,head), body));
}

// ---- 時間帯の目安（全日／昼／夜が、その人にとって何時から何時なのか） ----
const SLOT_KINDS=["all","day","night"];
const SLOT_START=540, SLOT_STEP=30, SLOT_COUNT=32;   // 9:00〜翌1:00 を30分刻み
const fmtMin=m=> m>=1440 ? `翌${Math.floor((m-1440)/60)}:${String((m-1440)%60).padStart(2,"0")}` : `${Math.floor(m/60)}:${String(m%60).padStart(2,"0")}`;
const slotRange=r=>`${fmtMin(r[0])}〜${fmtMin(r[1])}`;
// GMが未設定の卓・新しい卓に最初から入れておく値
const DEFAULT_SLOTS={all:[600,1470], day:[600,1080], night:[1260,1470]};
const slotsOrDefault=s=> s===undefined ? cloneSlots(DEFAULT_SLOTS) : cloneSlots(s);
function cloneSlots(s){
  const out={};
  for (const k of SLOT_KINDS){
    const r=s&&s[k];
    if (Array.isArray(r) && r.length===2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0]<r[1]) out[k]=[r[0],r[1]];
  }
  return out;
}
function slotsText(s){ return SLOT_KINDS.filter(k=>s&&s[k]).map(k=>`${MARK[k]} ${slotRange(s[k])}`).join(" / "); }
const renderFormSlots=()=>renderSlotPicker($("f-slots"), S.draft.slots||(S.draft.slots={}));
function renderSlotPicker(box, slots, hint, onChange){
  box.replaceChildren();
  const END=SLOT_START+SLOT_COUNT*SLOT_STEP;
  const opts=(from,to)=>{
    const o=[el("option",{value:"",text:"--:--"})];
    for (let m=from;m<=to;m+=SLOT_STEP) o.push(el("option",{value:String(m),text:fmtMin(m)}));
    return o;
  };
  const rows=el("div",{class:"slotrows"});
  for (const k of SLOT_KINDS){
    const st=el("select",{"aria-label":MARK[k]+"の開始"}, opts(SLOT_START,END-SLOT_STEP));
    const en=el("select",{"aria-label":MARK[k]+"の終了"}, opts(SLOT_START+SLOT_STEP,END));
    const sync=()=>{ const r=slots[k]; st.value=r?String(r[0]):""; en.value=r?String(r[1]):""; };
    st.addEventListener("change",()=>{
      if (!st.value){ delete slots[k]; sync(); onChange&&onChange(); return; }
      const s=+st.value, r=slots[k];
      let e = r && r[1]>s ? r[1] : Math.min(END, s+120);
      if (e<=s) e=s+SLOT_STEP;
      slots[k]=[s,e]; sync(); onChange&&onChange();
    });
    en.addEventListener("change",()=>{
      if (!en.value){ delete slots[k]; sync(); onChange&&onChange(); return; }
      const e=+en.value, r=slots[k];
      let s = r && r[0]<e ? r[0] : Math.max(SLOT_START, e-120);
      if (s>=e) s=e-SLOT_STEP;
      slots[k]=[s,e]; sync(); onChange&&onChange();
    });
    sync();
    rows.append(el("div",{class:"srow "+k}, el("span",{class:"sk",text:MARK[k]}), st, el("span",{text:"〜"}), en));
  }
  box.append(el("p",{class:"empty",style:"font-size:.85rem"},hint||"KPが設定した時間帯に変更希望がある場合は修正してください。"), rows);
}
function renderFormDates(){
  const box=$("f-answers"); box.replaceChildren();
  const dates=sortedDates();
  if (!dates.length){ box.append(el("p",{class:"empty",text:"候補日が追加されると、ここで 全日 / 昼 / 夜 / ✖ を選べます。"})); return; }
  for (const dt of dates){
    const cur=S.draft.answers[dt.id];
    const seg=el("div",{class:"seg",role:"group","aria-label":dateLabel(dt)+"の参加可否"},
      OPTS.map(v=>el("button",{type:"button","data-v":v,"aria-pressed":String(cur===v),title:DESC[v],
        onclick:(ev)=>{ if(S.draft.answers[dt.id]===v) delete S.draft.answers[dt.id]; else S.draft.answers[dt.id]=v;
          ev.currentTarget.parentNode.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",String(S.draft.answers[dt.id]===b.dataset.v))); }}, MARK[v])));
    box.append(el("div",{class:"arow"}, el("span",{class:"lbl"}, dateLabel(dt), dt.note? el("span",{class:"d-note",text:dt.note}):null), seg));
  }
}
function renderFormMode(){
  const editing=!!S.editingId;
  $("form-h").textContent = editing ? "回答を編集中" : "参加可能日程を入力する";
  $("new-btn").hidden = !editing;
  $("del-btn").hidden = !editing;
  $("save-btn").textContent = editing ? "変更を保存" : "回答を保存";
}
function startEdit(id){
  const p=S.players.find(x=>x.id===id); if(!p) return;
  S.editingId=id; S.draft={answers:{}, slots:cloneSlots(p.slots)};
  for (const dt of S.dates){ const v=ans(p,dt.id); if(v) S.draft.answers[dt.id]=v; }
  $("f-name").value=p.name||""; $("f-comment").value=p.comment||"";
  renderFormDates(); renderFormSlots(); renderFormMode(); openDlg($("form-dlg"));
}
function resetForm(){
  S.editingId=null; S.draft={answers:{}, slots:cloneSlots(S.meta&&S.meta.slotDefaults)}; $("f-name").value=""; $("f-comment").value="";
  renderFormDates(); renderFormSlots(); renderFormMode();
}

const delSel=new Set();
function renderGmDates(){
  const box=$("g-dates"); box.replaceChildren();
  const dates=sortedDates();
  const ids=new Set(dates.map(d=>d.id));
  for (const id of [...delSel]) if(!ids.has(id)) delSel.delete(id);
  if (!dates.length){ box.append(el("p",{class:"empty",text:"まだありません。"})); return; }
  const allBtn=el("button",{class:"btn small",type:"button"});
  const delBtn=el("button",{class:"btn small danger",type:"button"});
  const sync=()=>{
    allBtn.textContent = delSel.size===dates.length ? "選択を解除" : "すべて選択";
    delBtn.textContent = `選択した${delSel.size}件を削除`; delBtn.disabled = !delSel.size;
  };
  allBtn.addEventListener("click",()=>{
    if (delSel.size===dates.length) delSel.clear(); else dates.forEach(d=>delSel.add(d.id));
    renderGmDates();
  });
  delBtn.addEventListener("click",async()=>{
    const targets=dates.filter(d=>delSel.has(d.id)); if(!targets.length) return;
    if (!await confirmDel(`選択した${targets.length}件の候補日を削除しますか？`, targets.map(dateLabel).join("、"))) return;
    try{
      const batch=writeBatch(db);
      targets.forEach(d=>batch.delete(doc(db,"tables",tid,"dates",d.id)));
      await batch.commit(); delSel.clear(); toast(`${targets.length}件の候補日を削除しました`);
    }catch(e){ fail(e); }
  });
  box.append(el("div",{class:"actions"}, allBtn, delBtn));
  for (const dt of dates){
    const cb=el("input",{type:"checkbox"}); cb.checked=delSel.has(dt.id);
    cb.addEventListener("change",()=>{ if(cb.checked) delSel.add(dt.id); else delSel.delete(dt.id); sync(); });
    box.append(el("label",{class:"ditem"}, cb, el("span",null, dateLabel(dt), dt.note? el("span",{class:"d-note",text:dt.note}):null)));
  }
  sync();
}
function fillMetaInputs(){
  if (S.metaDirty) return;
  $("g-title").value=S.meta.title||""; $("g-scenario").value=S.meta.scenario||"";
  $("g-note").value=S.meta.note||""; $("g-status").value=S.meta.status||"adjusting";
  S.gSlots=slotsOrDefault(S.meta.slotDefaults);
  renderSlotPicker($("g-slots"), S.gSlots, "これを目安に、PLは変更希望を入力することができます。", ()=>{ S.metaDirty=true; });
}
function renderAll(){ renderHeader(); renderBest(); renderOverlap(); renderGrid(); renderGmDates(); }
function applyGM(){ const o=canManage(); $("gm-panel").hidden = !o; if (o){ fillMetaInputs(); renderCal(); } }

// 候補日追加カレンダー
const calSel=new Set();
const now=new Date(); let calMonth=new Date(now.getFullYear(),now.getMonth(),1);
function updateAddBtn(){
  const n=calSel.size, b=$("a-add");
  b.disabled = n===0; b.textContent = n ? `選んだ${n}日を追加` : "日付を選んでください";
  $("a-clear").hidden = n===0;
}
function renderCal(){
  const y=calMonth.getFullYear(), m=calMonth.getMonth();
  $("cal-title").textContent=`${y}年${m+1}月`;
  $("cal-prev").disabled = y<now.getFullYear() || (y===now.getFullYear() && m<=now.getMonth());
  const g=$("cal-grid"); g.replaceChildren();
  WD.forEach((w,i)=>g.append(el("span",{class:"cal-wd"+(i===0?" sun":""),text:w,"aria-hidden":"true"})));
  const lead=new Date(y,m,1).getDay(); for(let i=0;i<lead;i++) g.append(el("span"));
  const days=new Date(y,m+1,0).getDate(), todayIso=iso(new Date()), reg=new Set(S.dates.map(d=>d.date));
  for(let d=1; d<=days; d++){
    const dt=new Date(y,m,d), ds=iso(dt);
    const b=el("button",{type:"button",
      class:"cal-day"+(dt.getDay()===0?" sun":"")+(ds===todayIso?" today":"")+(reg.has(ds)?" has":""),
      "aria-pressed":String(calSel.has(ds)), "aria-label":fmtDate(ds)+(reg.has(ds)?"（登録済み）":""),
      disabled: ds<todayIso?"":null, text:String(d)});
    b.addEventListener("click",()=>{ if(calSel.has(ds)) calSel.delete(ds); else calSel.add(ds); b.setAttribute("aria-pressed",String(calSel.has(ds))); updateAddBtn(); });
    g.append(b);
  }
}

function bootTable(){
  $("view-table").hidden=false;
  const tableRef=doc(db,"tables",tid);
  const datesCol=collection(tableRef,"dates"), playersCol=collection(tableRef,"players");

  $("new-btn").addEventListener("click", resetForm);
  const openNew=()=>{ resetForm(); openDlg($("form-dlg")); setTimeout(()=>$("f-name").focus(),50); };
  $("open-btn").addEventListener("click", openNew);
  $("open-btn2").addEventListener("click", openNew);
  $("close-btn").addEventListener("click", ()=>closeDlg($("form-dlg")));
  $("form-dlg").addEventListener("close", resetForm);

  $("save-btn").addEventListener("click", async()=>{
    const name=$("f-name").value.trim();
    if(!name){ toast("名前を入れてください"); $("f-name").focus(); return; }
    const valid=new Set(S.dates.map(d=>d.id));
    const answers={}; for(const k in S.draft.answers) if(valid.has(k)) answers[k]=S.draft.answers[k];
    const comment=$("f-comment").value.trim();
    const slots=cloneSlots(S.draft.slots);
    const btn=$("save-btn"); btn.disabled=true;
    try{
      let msg;
      if (S.editingId){
        const prev=S.players.find(p=>p.id===S.editingId);
        await setDoc(doc(playersCol,S.editingId),{name, answers, slots, comment, createdAt:(prev&&prev.createdAt)||Date.now(), updatedAt:Date.now(), expireAt:(prev&&prev.expireAt)||newExpiry()});
        msg="変更を保存しました";
      } else {
        await addDoc(playersCol,{name, answers, slots, comment, createdAt:Date.now(), updatedAt:Date.now(), expireAt:newExpiry()});
        msg="回答を保存しました";
      }
      closeDlg($("form-dlg")); resetForm(); toast(msg);
    }catch(e){ fail(e); }
    finally{ btn.disabled=false; }
  });
  $("del-btn").addEventListener("click", async ()=>{
    if (!await confirmDel("この回答を削除しますか？")) return;
    try{ await deleteDoc(doc(playersCol,S.editingId)); closeDlg($("form-dlg")); resetForm(); toast("回答を削除しました"); }catch(e){ fail(e); }
  });
  $("copy-btn").addEventListener("click", ()=>{
    const name=$("f-name").value.trim()||"（名前未入力）";
    const lines=[`【${S.meta.title||"TRPG日程調整"}】${name}`];
    for (const dt of sortedDates()) lines.push(`${dateLabel(dt)} ${MARK[S.draft.answers[dt.id]]||"未回答"}`);
    const st=slotsText(S.draft.slots); if(st) lines.push("卓予定時間："+st);
    const c=$("f-comment").value.trim(); if(c) lines.push("コメント："+c);
    copyText(lines.join("\n"));
  });

  // GM
  ["g-title","g-scenario","g-note","g-status"].forEach(id=>$(id).addEventListener("input",()=>{S.metaDirty=true;}));
  $("g-save").addEventListener("click", async()=>{
    try{
      await updateDoc(tableRef,{title:$("g-title").value.trim(), scenario:$("g-scenario").value.trim(), note:$("g-note").value.trim(), status:$("g-status").value, slotDefaults:cloneSlots(S.gSlots)});
      S.metaDirty=false; toast("卓情報を保存しました");
    }catch(e){ fail(e); }
  });
  $("g-copy").addEventListener("click", ()=>copyText(tableLink(tid),"PL用のリンクをコピーしました"));
  $("cal-prev").addEventListener("click",()=>{ calMonth=new Date(calMonth.getFullYear(),calMonth.getMonth()-1,1); renderCal(); });
  $("cal-next").addEventListener("click",()=>{ calMonth=new Date(calMonth.getFullYear(),calMonth.getMonth()+1,1); renderCal(); });
  $("a-clear").addEventListener("click",()=>{ calSel.clear(); renderCal(); updateAddBtn(); });
  $("a-add").addEventListener("click", async()=>{
    const list=[...calSel].sort(); if(!list.length) return;
    const time="";
    const btn=$("a-add"); btn.disabled=true; let n=0, dup=0;
    try{
      for(const date of list){
        if (S.dates.some(d=>d.date===date&&(d.time||"")===time)){ dup++; calSel.delete(date); continue; }
        await addDoc(datesCol,{date, time, note:"", expireAt:newExpiry()}); n++; calSel.delete(date);
      }
      toast(`${n}日を追加しました`+(dup?`（${dup}日は登録済みのため省略）`:""));
    }catch(e){ fail(e); }
    finally{ renderCal(); updateAddBtn(); }
  });
  renderCal(); updateAddBtn(); renderFormMode();

  const onErr=e=>{ console.error(e); setStatus("データを読み込めませんでした。ページを開き直してください。","warn"); };
  onSnapshot(tableRef, s=>{
    S.tableExists=s.exists();
    if (!s.exists()){ setStatus("この卓は見つかりませんでした。リンクが正しいかGMに確認してください。","warn"); return; }
    S.meta=s.data()||{}; setStatus(""); renderHeader(); fillMetaInputs(); applyGM();
  }, onErr);
  onSnapshot(datesCol, q=>{ S.dates=q.docs.map(d=>({id:d.id,...d.data()})); renderAll(); renderFormDates(); if(S.isGM) renderCal(); }, onErr);
  onSnapshot(playersCol, q=>{ S.players=q.docs.map(d=>({id:d.id,...d.data()})); renderAll();
    if (S.editingId && !S.players.some(p=>p.id===S.editingId)) resetForm(); }, onErr);
}

// =========================================================
// 卓一覧（GM専用・パラメータなし）
// =========================================================
const FILTERS=[["active","進行中"],["adjusting","調整中"],["decided","日程決定"],["done","終了"],["all","すべて"]];
const ORDER={adjusting:0,decided:1,done:2};
const match=(it,f)=> f==="all" ? true : f==="active" ? it.status!=="done" : it.status===f;
let unsubTables=null;

async function deleteTableDeep(id){
  const ref=doc(db,"tables",id);
  for (const sub of ["dates","players"]){
    const snap=await getDocs(collection(ref,sub));
    let batch=writeBatch(db), n=0;
    for (const d of snap.docs){ batch.delete(d.ref); if(++n===400){ await batch.commit(); batch=writeBatch(db); n=0; } }
    if (n) await batch.commit();
  }
  await deleteDoc(ref);
}
const purging=new Set();
async function purgeExpired(){
  const now=Date.now();
  const old=S.tables.filter(it=>it.expireAt?.toMillis && it.expireAt.toMillis()<now && !purging.has(it.id));
  for (const it of old){
    purging.add(it.id);
    try{ await deleteTableDeep(it.id); }catch(e){ console.error(e); }
  }
  if (old.length) toast(`期限切れの卓を${old.length}件削除しました`);
}
const tableSel=new Set();
function renderList(){
  const gate=$("list-gate"), main=$("list-main");
  if (!S.user || !S.gmChecked || !S.isGM){
    main.hidden=true; $("add-table").hidden=true; gate.hidden=false; gate.replaceChildren();
    if (!S.authReady) gate.append(el("p",{text:"確認しています…"}));
    else if (!S.user) gate.append(el("p",null,"卓一覧はGM専用です。GMのGoogleアカウントでログインしてください。"),
      el("button",{class:"btn primary",type:"button",onclick:login},"Googleでログイン"));
    else if (!S.gmChecked) gate.append(el("p",{text:"確認しています…"}));
    else gate.append(el("p",{text:"このアカウントはGMとして登録されていません。PLの方は、GMから届いた卓のリンクを開いてください。"}));
    return;
  }
  gate.hidden=true; main.hidden=false; $("add-table").hidden=false;
  const mine=it=>it.ownerUid===S.user.uid;
  const pool = S.isAdmin && S.scope==="mine" ? S.tables.filter(mine) : S.tables;
  const fb=$("filter"); fb.replaceChildren();
  const sc=$("scope"); sc.hidden=!S.isAdmin; sc.replaceChildren();
  if (S.isAdmin) for (const [k,l] of [["mine","自分の卓"],["all","全員の卓"]])
    sc.append(el("button",{type:"button",role:"tab","aria-selected":String(S.scope===k),onclick:()=>{ S.scope=k; try{localStorage.setItem("taku.scope",k);}catch(_){} renderList(); }},
      l, el("span",{class:"n",text:String(k==="mine" ? S.tables.filter(mine).length : S.tables.length)})));  for (const [k,l] of FILTERS){
    fb.append(el("button",{type:"button","aria-pressed":String(S.filter===k),onclick:()=>{ S.filter=k; try{localStorage.setItem("taku.filter",k);}catch(_){} renderList(); }},
      l, el("span",{class:"n",text:String(pool.filter(it=>match(it,k)).length)})));
  }
  const box=$("tables"); box.replaceChildren();
  const items=pool.filter(it=>match(it,S.filter)).sort((a,b)=>
    (ORDER[a.status]??0)-(ORDER[b.status]??0) ||
    (b.createdAt||0)-(a.createdAt||0));
  for (const id of [...tableSel]) if(!items.some(it=>it.id===id)) tableSel.delete(id);
  if (!items.length){
    box.append(el("div",{class:"empty-card",text: pool.length ? "この状態の卓はありません。" : "卓はまだありません。右下の「＋ 新しい卓を作る」から作成できます。"}));
    return;
  }
  const allBtn=el("button",{class:"btn small",type:"button"});
  const delBtn=el("button",{class:"btn small danger",type:"button"});
  const sync=()=>{
    allBtn.textContent = tableSel.size===items.length ? "選択を解除" : "すべて選択";
    delBtn.textContent = `選択した${tableSel.size}件を削除`; delBtn.disabled = !tableSel.size;
  };
  allBtn.addEventListener("click",()=>{
    if (tableSel.size===items.length) tableSel.clear(); else items.forEach(it=>tableSel.add(it.id));
    renderList();
  });
  delBtn.addEventListener("click",async()=>{
    const targets=items.filter(it=>tableSel.has(it.id)); if(!targets.length) return;
    if (!await confirmDel(`選択した${targets.length}件の卓を削除しますか？`, targets.map(it=>it.title||"（卓名未設定）").join("、")+"\n回答・候補日もすべて消えます。")) return;
    delBtn.disabled=true;
    try{
      for (const it of targets) await deleteTableDeep(it.id);
      tableSel.clear(); toast(`${targets.length}件の卓を削除しました`);
    }catch(e){ fail(e); }
  });
  box.append(el("div",{class:"actions"}, allBtn, delBtn));
  sync();
  for (const it of items){
    const cb=el("input",{type:"checkbox","aria-label":"選択"}); cb.checked=tableSel.has(it.id);
    cb.addEventListener("change",()=>{ if(cb.checked) tableSel.add(it.id); else tableSel.delete(it.id); sync(); });
    box.append(el("article",{class:"card"+(it.status==="done"?" done":"")},
      el("label",{class:"name sel"}, cb, el("span",{text:it.title||"（卓名未設定）"})),
      el("span",{class:"pill "+(it.status||"adjusting"),text:ST[it.status]||"調整中"}),
      el("div",{class:"meta"},
        el("span",null,"シナリオ ",el("b",{text:it.scenario||"未設定"})),
        S.isAdmin ? el("span",null,"作成者 ",el("b",{text:mine(it) ? "自分" : (it.ownerEmail||"（不明）")})) : null),
      it.memo ? el("p",{class:"memo",text:it.memo}) : null,
      el("div",{class:"row-actions"},
        el("a",{class:"btn primary",href:"?t="+encodeURIComponent(it.id)},"日程調整を開く"),
        el("button",{class:"btn",type:"button",onclick:()=>copyText(tableLink(it.id),"PL用のリンクをコピーしました")},"リンクをコピー"),
        el("button",{class:"btn",type:"button",onclick:()=>openTableDlg(it.id)},"編集"))));
  }
}
function openTableDlg(id){
  S.editTableId=id||null;
  const it=id ? S.tables.find(x=>x.id===id) : null;
  $("t-h").textContent = it ? "卓を編集" : "新しい卓を作る";
  $("t-title").value=it?.title||""; $("t-scenario").value=it?.scenario||"";
  $("t-status").value=it?.status||"adjusting"; $("t-memo").value=it?.memo||"";
  $("t-extra").hidden=!it;
  S.tableSlots=slotsOrDefault(it?.slotDefaults);
  renderSlotPicker($("t-slots"), S.tableSlots, "これを目安に、PLは変更希望を入力することができます。");
  const del=$("t-del"); del.hidden=!it;
  openDlg($("table-dlg"));
}
function bootList(){
  $("view-list").hidden=false;
  if (S.isGM && !unsubTables){
    unsubTables=onSnapshot(S.isAdmin ? collection(db,"tables") : query(collection(db,"tables"), where("ownerUid","==",S.user.uid)), q=>{ S.tables=q.docs.map(d=>({id:d.id,...d.data()})); renderList(); purgeExpired(); },
      e=>{ console.error(e); toast("卓一覧を読み込めませんでした"); });
  }
  if (!S.isGM && unsubTables){ unsubTables(); unsubTables=null; S.tables=[]; }
  renderList();
}
function bindList(){
  $("add-table").addEventListener("click",()=>openTableDlg(null));
  $("t-close").addEventListener("click",()=>closeDlg($("table-dlg")));
  $("t-save").addEventListener("click", async()=>{
    const title=$("t-title").value.trim(); if(!title){ toast("卓名を入れてください"); $("t-title").focus(); return; }
    const b=$("t-save"); b.disabled=true;
    try{
      if (S.editTableId){
        await updateDoc(doc(db,"tables",S.editTableId),{title, scenario:$("t-scenario").value.trim(), status:$("t-status").value, slotDefaults:cloneSlots(S.tableSlots),
          memo:$("t-memo").value.trim()});
        closeDlg($("table-dlg")); toast("保存しました");
      } else {
        await addDoc(collection(db,"tables"),{title, scenario:$("t-scenario").value.trim(), time:"", note:"",
          status:"adjusting", slotDefaults:cloneSlots(S.tableSlots), memo:$("t-memo").value.trim(), createdAt:Date.now(),
          ownerUid:S.user.uid, ownerEmail:S.user.email||"", expireAt:newExpiry()});
        closeDlg($("table-dlg")); toast("卓を作りました。「日程調整を開く」から候補日を追加できます");
      }
    }catch(e){ fail(e); } finally{ b.disabled=false; }
  });
  $("t-del").addEventListener("click", async e=>{
    const b=e.currentTarget;
    if (!await confirmDel("この卓を削除しますか？", "回答・候補日もすべて消えます。")) return;
    b.disabled=true;
    try{
      await deleteTableDeep(S.editTableId);
      closeDlg($("table-dlg")); toast("卓を削除しました");
    }catch(err){ fail(err); } finally{ b.disabled=false; }
  });
}

// ---------- 起動 ----------
if (tid) bootTable();
else { bindList(); $("view-list").hidden=false; renderList(); }
renderAuth();
