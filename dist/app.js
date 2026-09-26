// 复核台前端：场景载入、Worker 回放、结论渲染、清空草稿、健康探测。

const $ = (id) => document.getElementById(id);
const els = {
  cnf: $('cnfInput'),
  drat: $('dratInput'),
  review: $('reviewBtn'),
  cancel: $('cancelBtn'),
  clear: $('clearBtn'),
  progress: $('progressText'),
  track: $('progressTrack'),
  bar: $('progressBar'),
  empty: $('emptyResult'),
  body: $('resultBody'),
  select: $('scenarioSelect'),
  healthDot: $('healthDot'),
  healthText: $('healthText'),
};

let worker = null;
let runId = 0;

// ---------- 健康检查 ----------
async function probeHealth() {
  try {
    const r = await fetch('/healthz');
    const j = await r.json();
    if (r.ok && j.status === 'ok') {
      els.healthDot.className = 'dot ok';
      els.healthText.textContent = '服务健康';
      return;
    }
    throw new Error('bad status');
  } catch {
    els.healthDot.className = 'dot bad';
    els.healthText.textContent = '服务不可达';
  }
}
probeHealth();
setInterval(probeHealth, 10000);

// ---------- 场景 ----------
async function loadScenarios() {
  try {
    const r = await fetch('/api/scenarios');
    const { scenarios } = await r.json();
    for (const s of scenarios) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      els.select.appendChild(opt);
    }
  } catch {
    /* 离线静态打开时静默 */
  }
}
els.select.addEventListener('change', async () => {
  const id = els.select.value;
  if (!id) return;
  const r = await fetch(`/api/scenarios/${encodeURIComponent(id)}`);
  const s = await r.json();
  els.cnf.value = s.cnf;
  els.drat.value = s.drat;
  clearResult();
  els.progress.textContent = `已载入场景：${s.title}`;
});
loadScenarios();

// ---------- 控件 ----------
els.review.addEventListener('click', startReview);
els.clear.addEventListener('click', () => {
  // 回放进行中清空：先终止 Worker，确保旧结论不会在结束后回填。
  if (worker) {
    worker.terminate();
    worker = null;
    setRunning(false);
  }
  els.cnf.value = '';
  els.drat.value = '';
  els.select.value = '';
  clearResult();
  els.progress.textContent = '草稿与结论已清空';
  els.bar.style.width = '0%';
  els.track.hidden = true;
});
els.cancel.addEventListener('click', () => {
  if (worker) worker.terminate();
  worker = null;
  setRunning(false);
  clearResult();
  els.empty.hidden = false;
  els.empty.textContent = '回放已中止；活动集状态不再有效，任何结论已清除。';
  els.progress.textContent = '已中止';
});

function setRunning(on) {
  els.review.disabled = on;
  els.cancel.disabled = !on;
  els.cnf.disabled = on;
  els.drat.disabled = on;
}

function clearResult() {
  // 每次新复核/清空都先抹掉旧结论，杜绝“无解”残留。
  els.body.hidden = true;
  els.body.innerHTML = '';
  els.empty.hidden = false;
}

function startReview() {
  clearResult();
  setRunning(true);
  els.track.hidden = false;
  els.bar.style.width = '2%';
  els.progress.textContent = '回放中…';
  runId++;

  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      const pct = m.total ? Math.min(98, (m.processed / m.total) * 100) : 30;
      els.bar.style.width = `${pct}%`;
      els.progress.textContent = `回放中 ${m.processed}/${m.total} 条`;
    } else if (m.type === 'done') {
      finish();
      renderResult(m.result);
    } else if (m.type === 'error') {
      finish();
      renderFatal(m.message);
    }
  };
  worker.onerror = (e) => {
    finish();
    renderFatal(e.message);
  };
  worker.postMessage({ type: 'review', cnf: els.cnf.value, drat: els.drat.value });

  function finish() {
    worker?.terminate();
    worker = null;
    setRunning(false);
    els.bar.style.width = '100%';
    setTimeout(() => (els.track.hidden = true), 350);
  }
}

// ---------- 渲染 ----------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function fmtLits(lits) {
  if (!lits || lits.length === 0) return '<span class="empty">□（空矛盾）</span>';
  return lits.map(esc).join(' ∨ ') + ' 0';
}

function renderResult(r) {
  els.empty.hidden = true;
  els.body.hidden = false;
  els.body.innerHTML = '';

  els.body.appendChild(renderVerdict(r));

  if (r.verdict === 'INPUT_ERROR') {
    els.body.appendChild(renderInputErrors(r));
    return;
  }

  if (r.verdict === 'FAILED_STEP') {
    els.body.appendChild(renderFailure(r));
  }

  if (Array.isArray(r.steps) && r.steps.length > 0) {
    const t = sectionTitle(`成功步骤（${r.steps.length}）— 点击展开核对依据`);
    els.body.appendChild(t);
    const wrap = document.createElement('div');
    wrap.className = 'steps';
    r.steps.forEach((s) => wrap.appendChild(renderStep(s, r.failedStep)));
    els.body.appendChild(wrap);
  }

  const active = r.verdict === 'FAILED_STEP' ? r.activeAtFailure : r.finalActive;
  if (Array.isArray(active)) {
    els.body.appendChild(sectionTitle(`失败当时的活动约束摘要（${active.length} 条）`));
    els.body.appendChild(renderActive(active));
  }
}

function sectionTitle(text) {
  const d = document.createElement('div');
  d.className = 'section-title';
  d.textContent = text;
  return d;
}

const VERDICT_META = {
  UNSAT: ['不可满足 UNSAT', '只有活动集得到空子句，才允许作出本裁决'],
  FAILED_STEP: ['首个失败步骤', '回放在此停止；其后的记录未被采纳，旧结论作废'],
  INPUT_ERROR: ['输入未通过受限语法校验', '未进行证明回放；请先清除下列问题后再提交'],
  INCOMPLETE: ['证明不完整', '全部步骤成立但活动集没有空子句，不能裁决不可满足'],
};

function renderVerdict(r) {
  const [title, tail] = VERDICT_META[r.verdict] ?? [r.verdict, ''];
  const box = document.createElement('div');
  box.className = `verdict ${r.verdict}`;
  box.innerHTML = `
    <span class="badge">${esc(r.verdict)}</span>
    <div>
      <h3>${esc(title)}</h3>
      <p>${esc(r.message ?? tail)}</p>
    </div>`;
  return box;
}

function renderInputErrors(r) {
  const wrap = document.createElement('div');
  const table = document.createElement('table');
  table.className = 'errors';
  table.innerHTML = `
    <thead><tr><th>#</th><th>类别</th><th>位置（行:列）</th><th>说明</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  r.inputErrors.forEach((e, i) => {
    const tr = document.createElement('tr');
    const locs =
      e.locations.length > 0
        ? e.locations.map((l) => `<span class="loc">${l.line}:${l.col}</span>`).join(' ')
        : '<span class="loc">—</span>';
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><code>${esc(e.code)}</code><div class="kv">${esc(e.scope.toUpperCase())}</div></td>
      <td>${locs}</td>
      <td>${esc(e.message)}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderFailure(r) {
  const box = document.createElement('div');
  box.className = 'fail-box';
  const rec = r.failedRecord ?? {};
  let extra = '';
  if (r.ratFailure) {
    const f = r.ratFailure;
    extra = `
      <div class="kv">RAT 枢轴：<b class="lits">${esc(r.pivot)}</b></div>
      <div class="kv">首个核对失败的反向文字子句：<b class="lits">${esc(f.id)}：${fmtLits(f.lits)}</b></div>
      <pre>消解式 = ${fmtLits(f.resolvent)}</pre>`;
  }
  if (Array.isArray(r.rupStalled?.propagations)) {
    const st = r.rupStalled;
    extra += `<div class="kv">RUP 未冲突：单位传播在未定变量处停止（已决变量 ${st.decidedVars}${st.unassignedVars != null ? ` / 未决 ${st.unassignedVars}` : ''}）。</div>`;
    if (st.propagations.length === 0) extra += '<pre>（活动集为空或无单位传播，反设后无从冲突）</pre>';
    for (const p of st.propagations.slice(-12)) {
      extra += `<pre>${esc(p.lit)} 由 ${esc(p.by)} 单位传播</pre>`;
    }
  }
  box.innerHTML = `
    <h4>第 ${r.failedStep} 条记录（原文件第 ${rec.line ?? '?'} 行）· <code>${esc(r.code)}</code></h4>
    <pre>${rec.del ? 'd ' : ''}${fmtLits(rec.lits ?? [])}</pre>
    ${extra}`;
  return box;
}

function renderStep(s) {
  const card = document.createElement('div');
  card.className = 'step';
  const head = document.createElement('div');
  head.className = 'step-head';
  const clauseText = s.rule === 'DELETE' ? fmtLits(s.target) : fmtLits(s.lits);
  head.innerHTML = `
    <span class="idx">#${s.index}</span>
    <span class="rule-tag ${s.rule}">${s.rule}</span>
    <span class="clause">${s.rule === 'DELETE' ? 'd ' : ''}${clauseText}</span>
    <span class="meta">活动子句 ${s.activeCountAfter} 条 · 行 ${s.line}</span>`;
  const body = document.createElement('div');
  body.className = 'step-body';
  body.hidden = true;
  head.addEventListener('click', () => (body.hidden = !body.hidden));

  if (s.rule === 'DELETE') {
    body.innerHTML = `<div class="kv">已从活动集立即移除：<b class="lits">${esc(s.removedId)}</b>；后续任何依据不得再引用。</div>`;
  } else if (s.rule === 'RUP') {
    body.appendChild(renderRUP(s));
  } else if (s.rule === 'RAT') {
    body.appendChild(renderRAT(s));
  }

  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function renderRUP(s) {
  const d = document.createElement('div');
  const assump = s.assumptions && s.assumptions.length ? s.assumptions.map((a) => esc(-a)).join(' ∧ ') : '（无反设文字）';
  let html = `
    <div class="kv">规则：<b>RUP</b> — 反设新增文字为假（<span class="lits">${assump}</span>）后，在当前活动集上单位传播导出冲突。</div>
    <div class="kv">冲突子句编号链（沿单位传播原因回溯）：</div>
    <ul class="chain">`;
  for (const c of s.chain ?? []) {
    const role = c.role === 'conflict' ? '冲突子句' : '传播依据';
    html += `<li class="${c.role}"><span class="cid">${esc(c.id)}</span>：${fmtLits(c.lits)}<span class="role">${role}</span></li>`;
  }
  html += `</ul><div class="kv">传播序列：</div><ul class="chain">`;
  for (const p of s.propagations ?? []) {
    html += `<li class="prop"><span class="lits">${esc(p.lit)}</span> 由 <span class="cid">${esc(p.by)}</span> 单位传播</li>`;
  }
  if ((s.propagations ?? []).length === 0 && (s.assumptions ?? []).length === 0) {
    html += `<li class="prop">活动集单位子句直接互补，无需传播即冲突</li>`;
  }
  html += '</ul>';
  d.innerHTML = html;
  return d;
}

function renderRAT(s) {
  const d = document.createElement('div');
  let html = `
    <div class="kv">规则：<b>RAT</b> — 以新子句首文字 <b class="lits">${esc(s.pivot)}</b> 为指定枢轴。</div>
    <div class="kv">活动集中含 ¬pivot（<span class="lits">${esc(-s.pivot)}</span>）的子句共 <b>${s.oppositeCount}</b> 个；逐一核对全部反向文字子句：</div>
    <div class="rat-checks">`;
  if (s.oppositeCount === 0) {
    html += `<div class="rat-check">无反向文字子句：RAT 条件对零个子句<b>空成立</b>。</div>`;
  }
  for (const c of s.ratChecks ?? []) {
    html += `
      <div class="rat-check">
        <span class="cid">${esc(c.id)}</span>：<span class="lits">${fmtLits(c.lits)}</span><br/>
        消解式：<span class="lits">${fmtLits(c.resolvent)}</span>
        <span class="verdict-mini ${c.tautology ? 'taut' : 'rup'}">${c.tautology ? '重言式 ✓' : 'RUP 冲突链 ✓'}</span>
      </div>`;
  }
  html += '</div>';
  d.innerHTML = html;
  return d;
}

function renderActive(list) {
  const wrap = document.createElement('div');
  wrap.className = 'active-clauses';
  if (list.length === 0) {
    wrap.innerHTML = '<span class="kv">（活动集为空）</span>';
    return wrap;
  }
  for (const c of list) {
    const chip = document.createElement('span');
    chip.className = 'clause-chip' + (c.lits.length === 0 ? ' empty' : '');
    chip.innerHTML = `<span class="cid">${esc(c.id)}</span>${fmtLits(c.lits)}`;
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderFatal(message) {
  clearResult();
  els.empty.hidden = false;
  els.empty.innerHTML = `复核执行出错：${esc(message)}`;
}
