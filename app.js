'use strict';

const STORAGE_KEY='numbers3-web-user-v1';
const DATA_CACHE_KEY='numbers3-web-results-v1';
const WINDOWS=[30,50,100,200,500];
const METHODS={
  ensemble:{title:'総合バランス',description:'頻度・直近重視・推移の3方式を同じ重みでまとめます。'},
  frequency:{title:'位置別頻度',description:'百・十・一の位ごとによく出た数字を重視します。'},
  recent:{title:'直近重視',description:'新しい抽せんほど大きな重みを付けます。'},
  transition:{title:'数字の推移',description:'直前回と同じ数字が過去に出た後の推移を見ます。'}
};
const METHOD_ORDER=['ensemble','frequency','recent','transition'];
const RAKUTEN_PURCHASE='https://takarakuji.rakuten.co.jp/numbers/purchase/3/';
const OFFICIAL='https://www.mizuhobank.co.jp/takarakuji/check/numbers/numbers3/index.html';

let dataset=null;
let results=[];
let resultByDraw=new Map();
let userState=loadUserState();

function loadUserState(){
  const empty={version:1,window:200,method:'ensemble',finalNumber:'',finalContext:'',targetDate:'',targetContext:'',predictions:[],audit:[]};
  try{
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
    if(!saved||saved.version!==1) return empty;
    return {...empty,...saved,predictions:Array.isArray(saved.predictions)?saved.predictions:[],audit:Array.isArray(saved.audit)?saved.audit:[]};
  }catch{return empty;}
}

function saveUserState(){localStorage.setItem(STORAGE_KEY,JSON.stringify(userState));}
function yen(value){return new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0}).format(value);}
function formatDateTime(value){return value?new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(value)):'—';}
function todayJST(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function hourJST(){return Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',hour:'2-digit',hourCycle:'h23'}).format(new Date()));}
function weekdayJST(){return new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',weekday:'short'}).format(new Date());}
function isThreeDigits(value){return /^[0-9]{3}$/.test(value);}
function isBeforeCutoff(date){return date===todayJST()&&hourJST()<18&&!['Sat','Sun'].includes(weekdayJST());}
function escapeHTML(value){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));}
function setMessage(text,type='success'){
  const element=document.querySelector('#message');
  element.textContent=text;element.className=`message ${type}`;element.hidden=false;
  window.scrollTo({top:0,behavior:'smooth'});
}

function validateDataset(payload){
  if(!payload||payload.schema!==1||!Array.isArray(payload.results)||payload.results.length<30) throw new Error('結果データの形式を確認できません。');
  let previous=null;
  for(const row of payload.results){
    if(!Number.isInteger(row.draw)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(row.date)||!isThreeDigits(row.number)) throw new Error('結果データに不正な項目があります。');
    if(previous!==null&&row.draw!==previous+1) throw new Error(`第${previous+1}回以降に欠損があります。`);
    previous=row.draw;
  }
  if(payload.results.at(-1).draw!==payload.verifiedLatestDraw) throw new Error('照合済み最新回と結果が一致しません。');
}

async function refreshData(showNotice=false){
  const button=document.querySelector('#refresh-button');
  button.disabled=true;button.textContent='…';
  try{
    const response=await fetch(`data/results.json?v=${Date.now()}`,{cache:'no-store'});
    if(!response.ok) throw new Error(`データ取得エラー（HTTP ${response.status}）`);
    const payload=await response.json();validateDataset(payload);
    dataset=payload;results=payload.results;resultByDraw=new Map(results.map(row=>[row.draw,row]));
    localStorage.setItem(DATA_CACHE_KEY,JSON.stringify(payload));
    renderAll();
    if(showNotice) setMessage(`第${payload.verifiedLatestDraw}回まで、2つの公式結果で照合済みです。`);
  }catch(error){
    try{
      const cached=JSON.parse(localStorage.getItem(DATA_CACHE_KEY)||'null');validateDataset(cached);
      dataset=cached;results=cached.results;resultByDraw=new Map(results.map(row=>[row.draw,row]));renderAll();
      setMessage(`通信できないため、端末内の第${cached.verifiedLatestDraw}回までのデータを表示しています。`,'error');
    }catch{setMessage(error.message||'結果データを取得できません。','error');}
  }finally{button.disabled=false;button.textContent='↻';}
}

function blankCounts(){return Array.from({length:3},()=>Array(10).fill(1));}
function normalize(counts){return counts.map(row=>{const total=row.reduce((a,b)=>a+b,0);return row.map(value=>value/total);});}
function frequency(windowSize){
  const counts=blankCounts();
  for(const row of results.slice(-windowSize)) [...row.number].forEach((digit,position)=>counts[position][Number(digit)]++);
  return normalize(counts);
}
function recent(windowSize){
  const selected=results.slice(-windowSize),counts=blankCounts(),halfLife=Math.max(10,Math.min(60,selected.length));
  [...selected].reverse().forEach((row,age)=>{const weight=Math.pow(.5,age/halfLife);[...row.number].forEach((digit,position)=>counts[position][Number(digit)]+=weight);});
  return normalize(counts);
}
function transition(windowSize){
  const counts=blankCounts();if(!results.length) return normalize(counts);
  const selected=results.slice(-(windowSize+1)),latest=[...results.at(-1).number];
  for(let i=0;i<selected.length-1;i++){
    const before=[...selected[i].number],after=[...selected[i+1].number];
    for(let position=0;position<3;position++) if(before[position]===latest[position]) counts[position][Number(after[position])]++;
  }
  return normalize(counts);
}
function probabilities(method,windowSize){
  if(method==='frequency') return frequency(windowSize);
  if(method==='recent') return recent(windowSize);
  if(method==='transition') return transition(windowSize);
  const all=[frequency(windowSize),recent(windowSize),transition(windowSize)];
  return Array.from({length:3},(_,position)=>Array.from({length:10},(_,digit)=>all.reduce((sum,p)=>sum+p[position][digit],0)/3));
}
function scoreNumber(number,method,windowSize){
  if(!isThreeDigits(number)) return 0;
  const p=probabilities(method,windowSize);
  return [...number].reduce((score,digit,position)=>score*p[position][Number(digit)],1);
}
function topNumber(method,windowSize){
  const p=probabilities(method,windowSize);
  return p.map(row=>row.reduce((best,value,index)=>value>row[best]?index:best,0)).join('');
}
function getCandidates(){return METHOD_ORDER.map(method=>{const number=topNumber(method,userState.window);return {method,number,score:scoreNumber(number,method,userState.window)};});}

function syncFinalNumber(candidates){
  if(!results.length) return;
  const context=`${results.at(-1).draw}:${userState.window}:${userState.method}`;
  if(userState.finalContext!==context||!isThreeDigits(userState.finalNumber)){
    userState.finalNumber=candidates.find(item=>item.method===userState.method).number;
    userState.finalContext=context;saveUserState();
  }
  const targetContext=String(results.at(-1).draw+1);
  if(userState.targetContext!==targetContext) {
    userState.targetDate=todayJST();userState.targetContext=targetContext;saveUserState();
  }
}

function renderSummary(){
  document.querySelector('#result-count').textContent=results.length?`${results.length.toLocaleString()}回`:'—';
  document.querySelector('#latest-draw').textContent=results.length?`第${results.at(-1).draw}回`:'—';
  document.querySelector('#latest-date').textContent=results.length?results.at(-1).date.replaceAll('-','/'):'—';
}

function hero(label,draw,number){return `<div class="hero"><div class="eyebrow">${label}・第${draw}回</div><div class="number">${escapeHTML(number)}</div><div class="foot">STRAIGHT / 1口 ¥200</div></div>`;}

function renderToday(){
  const panel=document.querySelector('#today');
  if(results.length<30){panel.innerHTML='<div class="card"><h2>データを取得できません</h2><p>「データ」から再読み込みしてください。</p></div>';return;}
  const latest=results.at(-1),target=latest.draw+1;
  const active=userState.predictions.find(item=>item.draw===target);
  if(active){
    const canCancel=!active.purchasedAt&&!resultByDraw.has(active.draw)&&isBeforeCutoff(active.date);
    const canPurchase=!active.purchasedAt&&isBeforeCutoff(active.date);
    panel.innerHTML=`
      ${hero('確定済みの予想',target,active.number)}
      <div class="card">
        <p class="small">${METHODS[active.method].title}・直近${active.window}回 ／ 確定 ${formatDateTime(active.createdAt)}</p>
        ${active.purchasedAt?'<div class="warning">購入記録済みです。確定の取り消しはできません。</div>':`<button id="cancel-prediction" class="button danger" ${canCancel?'':'disabled'}>予想の確定を取り消す</button>`}
        <a class="link-button" href="${RAKUTEN_PURCHASE}" target="_blank" rel="noopener">楽天でナンバーズ3を購入</a>
        ${active.purchasedAt?`<p class="small">購入記録：${formatDateTime(active.purchasedAt)}</p>`:`<button id="mark-purchased" class="button secondary" ${canPurchase?'':'disabled'}>実際に1口購入したことを記録</button>`}
        <p class="small">楽天側へ番号は自動入力されません。ストレート1口・番号・回号をご自身で確認してください。</p>
      </div>`;
    document.querySelector('#cancel-prediction')?.addEventListener('click',()=>{
      userState.audit.push({id:crypto.randomUUID(),action:'cancelled',prediction:active,eventAt:new Date().toISOString()});
      userState.predictions=userState.predictions.filter(item=>item.id!==active.id);saveUserState();renderAll();setMessage(`第${target}回「${active.number}」の確定を取り消しました。`);
    });
    document.querySelector('#mark-purchased')?.addEventListener('click',()=>{
      active.purchasedAt=new Date().toISOString();saveUserState();renderAll();setMessage(`第${target}回「${active.number}」の購入を記録しました。`);
    });
    return;
  }
  const candidates=getCandidates();syncFinalNumber(candidates);
  const score=scoreNumber(userState.finalNumber,userState.method,userState.window);
  panel.innerHTML=`
    <div class="card">
      <div class="field"><label for="window-select">集計期間</label><select id="window-select">${WINDOWS.map(value=>`<option value="${value}" ${value===userState.window?'selected':''}>直近 ${value} 回</option>`).join('')}</select></div>
      <h2>4つの分析候補</h2>
      <div class="candidate-grid">${candidates.map(item=>`<button class="candidate ${item.method===userState.method?'selected':''}" data-method="${item.method}"><span>${METHODS[item.method].title}</span><strong>${item.number}</strong></button>`).join('')}</div>
      <p class="small">${METHODS[userState.method].description}</p>
      <div class="field"><label for="final-number">最終的に確定する3桁</label><input id="final-number" class="number-input" inputmode="numeric" maxlength="3" value="${escapeHTML(userState.finalNumber)}"></div>
    </div>
    ${hero('最終候補',target,isThreeDigits(userState.finalNumber)?userState.finalNumber:'---')}
    <div class="card">
      <p class="small">分析スコア：${(score*1_000_000).toFixed(2)}（順位付け用の指数で、当せん確率ではありません）</p>
      <div class="field"><label for="target-date">対象の抽せん日</label><input id="target-date" type="date" value="${escapeHTML(userState.targetDate)}"></div>
      <label class="check"><input id="official-check" type="checkbox"><span>公式ページで、第${target}回・この日付がこれから行われる抽せんであることを確認しました</span></label>
      <button id="confirm-prediction" class="button primary" disabled>この数字で予想を確定</button>
      <a class="link-button" href="${RAKUTEN_PURCHASE}" target="_blank" rel="noopener">楽天でナンバーズ3を購入</a>
      <p class="small">確定・購入記録は対象日当日の18時より前のみです。アプリから購入操作は行いません。</p>
    </div>`;
  document.querySelector('#window-select').addEventListener('change',event=>{userState.window=Number(event.target.value);userState.finalContext='';saveUserState();renderAll();});
  document.querySelectorAll('.candidate').forEach(button=>button.addEventListener('click',()=>{userState.method=button.dataset.method;userState.finalContext='';saveUserState();renderAll();}));
  const finalInput=document.querySelector('#final-number'),dateInput=document.querySelector('#target-date'),check=document.querySelector('#official-check'),confirm=document.querySelector('#confirm-prediction');
  const updateConfirm=()=>{confirm.disabled=!(isThreeDigits(finalInput.value)&&check.checked&&isBeforeCutoff(dateInput.value));};
  finalInput.addEventListener('input',event=>{event.target.value=event.target.value.replace(/[^0-9]/g,'').slice(0,3);userState.finalNumber=event.target.value;saveUserState();updateConfirm();});
  dateInput.addEventListener('change',event=>{userState.targetDate=event.target.value;saveUserState();updateConfirm();});
  check.addEventListener('change',updateConfirm);
  confirm.addEventListener('click',()=>{
    const prediction={id:crypto.randomUUID(),draw:target,date:userState.targetDate,number:userState.finalNumber,score:scoreNumber(userState.finalNumber,userState.method,userState.window),method:userState.method,window:userState.window,createdAt:new Date().toISOString(),purchasedAt:null};
    userState.predictions.push(prediction);userState.audit.push({id:crypto.randomUUID(),action:'confirmed',prediction:{...prediction},eventAt:prediction.createdAt});saveUserState();renderAll();setMessage(`第${target}回「${prediction.number}」を確定しました。`);
  });
}

function renderAnalysis(){
  const panel=document.querySelector('#analysis');
  if(!results.length){panel.innerHTML='';return;}
  const candidates=getCandidates(),counts=Array.from({length:3},()=>Array(10).fill(0));
  results.slice(-userState.window).forEach(row=>[...row.number].forEach((digit,position)=>counts[position][Number(digit)]++));
  panel.innerHTML=`
    <div class="card"><h2>直近${userState.window}回の候補</h2>${candidates.map(item=>`<div class="method-row"><div><b>${METHODS[item.method].title}</b><p>${METHODS[item.method].description}</p></div><strong>${item.number}</strong></div>`).join('')}</div>
    <div class="card"><h2>各桁の出現上位</h2>${['百の位','十の位','一の位'].map((label,position)=>{const ordered=counts[position].map((count,digit)=>({digit,count})).sort((a,b)=>b.count-a.count||a.digit-b.digit).slice(0,3);return `<div class="method-row"><div><b>${label}</b><p>${ordered.map(item=>`${item.digit}：${item.count}回`).join(' ／ ')}</p></div></div>`;}).join('')}<p class="small">公正で独立した抽せんなら、過去の頻度で次回の確率が上がる根拠はありません。</p></div>`;
}

function historyStatus(prediction,actual){
  if(!actual) return {label:'結果待ち',className:''};
  if(actual.date!==prediction.date) return {label:'日付不一致',className:'miss'};
  return actual.number===prediction.number?{label:'HIT',className:'hit'}:{label:'MISS',className:'miss'};
}

function renderHistory(){
  const panel=document.querySelector('#history'),predictions=[...userState.predictions].sort((a,b)=>b.draw-a.draw);
  const purchased=predictions.filter(item=>item.purchasedAt),settled=purchased.filter(item=>resultByDraw.has(item.draw)&&resultByDraw.get(item.draw).date===item.date);
  const wins=settled.filter(item=>resultByDraw.get(item.draw).number===item.number).reduce((sum,item)=>sum+(resultByDraw.get(item.draw).straightPayout||0),0);
  const cost=settled.length*200;
  panel.innerHTML=`
    <div class="money-grid"><div><span>購入記録</span><strong>${yen(purchased.length*200)}</strong></div><div><span>結果確定分</span><strong>${yen(cost)}</strong></div><div><span>確定収支</span><strong>${yen(wins-cost)}</strong></div></div>
    <div class="card"><h2>予想履歴</h2>${predictions.length?predictions.map(item=>{const actual=resultByDraw.get(item.draw),status=historyStatus(item,actual);return `<div class="history-item"><div class="history-head"><div><span class="small">第${item.draw}回・${item.date}</span><div class="history-number">${item.number}</div></div><span class="badge ${status.className}">${status.label}</span></div><p class="small">結果：${actual?actual.number:'—'} ／ ${item.purchasedAt?'購入済み':'未購入'}${status.label==='HIT'?` ／ 当せん ${yen(actual.straightPayout||0)}`:''}</p></div>`;}).join(''):'<p class="small">確定した予想がここに表示されます。</p>'}</div>
    <div class="card"><h2>バックアップ</h2><button id="export-backup" class="button secondary">予想・収支を書き出す</button><button id="import-backup" class="button secondary">バックアップから復元</button><p class="small">機種変更やSafariデータ消去に備え、時々ファイルへ書き出してください。</p>${userState.audit.some(item=>item.action==='cancelled')?`<details><summary>取り消し履歴</summary>${userState.audit.filter(item=>item.action==='cancelled').slice().reverse().map(item=>`<p class="small">第${item.prediction.draw}回「${item.prediction.number}」・${formatDateTime(item.eventAt)}</p>`).join('')}</details>`:''}</div>`;
  document.querySelector('#export-backup').addEventListener('click',exportBackup);
  document.querySelector('#import-backup').addEventListener('click',()=>document.querySelector('#restore-file').click());
}

function renderData(){
  const panel=document.querySelector('#data');
  if(!dataset){panel.innerHTML='';return;}
  panel.innerHTML=`
    <div class="card"><h2>2つの公式結果で照合</h2><p>第${dataset.verifiedLatestDraw}回まで照合済みです。今回の重複確認は${dataset.overlapChecked}件です。</p><button id="data-refresh" class="button secondary">最新データを確認</button><p class="small">最終更新：${formatDateTime(dataset.updatedAt)}。片方だけの更新、不一致、403・429では公開データを更新しません。</p>${dataset.sources.map(source=>`<a class="source" href="${source.url}" target="_blank" rel="noopener">${escapeHTML(source.name)}</a>`).join('')}<a class="source" href="${OFFICIAL}" target="_blank" rel="noopener">みずほ銀行の公式結果</a></div>
    <div class="card"><h2>iPhoneへの保存</h2><p>予想・購入・収支はこのSafari内だけに保存され、GitHubや他の利用者には送信されません。</p><p class="small">Safariの共有ボタンから「ホーム画面に追加」を選ぶと、アプリのように開けます。Safariの履歴・Webサイトデータを消すと記録も消えるため、バックアップをご利用ください。</p></div>`;
  document.querySelector('#data-refresh').addEventListener('click',()=>refreshData(true));
}

function renderAll(){renderSummary();renderToday();renderAnalysis();renderHistory();renderData();}

function exportBackup(){
  const blob=new Blob([JSON.stringify({app:'Numbers3Web',exportedAt:new Date().toISOString(),state:userState},null,2)],{type:'application/json'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`numbers3-backup-${todayJST()}.json`;link.click();URL.revokeObjectURL(link.href);
}

document.querySelector('#restore-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try{
    const backup=JSON.parse(await file.text());
    if(backup.app!=='Numbers3Web'||backup.state?.version!==1||!Array.isArray(backup.state.predictions)) throw new Error('このアプリのバックアップではありません。');
    if(!confirm('現在の予想・収支をバックアップの内容に置き換えますか？')) return;
    userState=backup.state;saveUserState();renderAll();setMessage('バックアップを復元しました。');
  }catch(error){setMessage(error.message||'復元できませんでした。','error');}
  event.target.value='';
});

document.querySelectorAll('.tab').forEach(button=>button.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab===button));
  document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('active',panel.id===button.dataset.tab));
}));
document.querySelector('#refresh-button').addEventListener('click',()=>refreshData(true));

if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
refreshData(false);
