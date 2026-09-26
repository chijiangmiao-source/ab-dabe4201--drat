/* 深空推进器联锁规程审查台 —— 前端逻辑（无依赖，原生 JS）。 */
'use strict';

(function () {
  var cnfEl = document.getElementById('cnf');
  var dratEl = document.getElementById('drat');
  var resultEl = document.getElementById('result');
  var verifyBtn = document.getElementById('verify-btn');
  var clearBtn = document.getElementById('clear-btn');
  var busyEl = document.getElementById('busy');

  var LS_CNF = 'drat-review.cnf';
  var LS_DRAT = 'drat-review.drat';
  var STEP_BATCH = 200; // 较长回放分批渲染，保持页面可操作
  var CHAIN_CAP = 200; // 单条冲突链展示上限
  var ACTIVE_CAP = 200; // 有效约束摘要展示上限

  /* ---------- 草稿持久化与清除 ---------- */

  function restoreDraft() {
    try {
      cnfEl.value = localStorage.getItem(LS_CNF) || '';
      dratEl.value = localStorage.getItem(LS_DRAT) || '';
    } catch (e) { /* localStorage 不可用时忽略 */ }
  }

  function persistDraft() {
    try {
      localStorage.setItem(LS_CNF, cnfEl.value);
      localStorage.setItem(LS_DRAT, dratEl.value);
    } catch (e) { /* 忽略 */ }
  }

  function clearResult() {
    resultEl.replaceChildren();
  }

  function onInput() {
    persistDraft();
    clearResult(); // 输入已变，清除旧结论，避免误读过期裁决
  }

  cnfEl.addEventListener('input', onInput);
  dratEl.addEventListener('input', onInput);

  clearBtn.addEventListener('click', function () {
    cnfEl.value = '';
    dratEl.value = '';
    try {
      localStorage.removeItem(LS_CNF);
      localStorage.removeItem(LS_DRAT);
    } catch (e) { /* 忽略 */ }
    clearResult();
    cnfEl.focus();
  });

  /* ---------- 验收示例 ---------- */

  var examplesPromise = null;
  function loadExamples() {
    if (!examplesPromise) {
      examplesPromise = fetch('/api/examples').then(function (r) { return r.json(); });
    }
    return examplesPromise;
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-ex]'), function (btn) {
    btn.addEventListener('click', function () {
      loadExamples().then(function (data) {
        var ex = (data.examples || []).filter(function (e) { return e.id === btn.getAttribute('data-ex'); })[0];
        if (!ex) return;
        cnfEl.value = ex.cnf;
        dratEl.value = ex.drat;
        persistDraft();
        runVerify();
      }).catch(function () {
        renderFatal('示例载入失败：服务不可达');
      });
    });
  });

  /* ---------- 复核 ---------- */

  verifyBtn.addEventListener('click', runVerify);

  function runVerify() {
    clearResult();
    verifyBtn.disabled = true;
    busyEl.hidden = false;
    fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cnf: cnfEl.value, drat: dratEl.value }),
    }).then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { renderFatal('复核请求失败：服务不可达'); })
      .finally(function () {
        verifyBtn.disabled = false;
        busyEl.hidden = true;
      });
  }

  /* ---------- 渲染 ---------- */

  var BANNERS = {
    unsat: ['ok', '裁决：不可满足（UNSAT）—— 活动约束集已导出空子句，联锁规程无解成立'],
    incomplete: ['warn', '证明步骤全部成立，但未导出空子句 —— 无法裁决不可满足'],
    step_failed: ['bad', '证明无效 —— 首个失败步骤见下，当时有效约束摘要附后'],
    invalid_input: ['bad', '输入非法 —— 全部问题已合并定位如下（旧结论已清除）'],
    error: ['bad', '服务返回错误'],
  };

  function render(data) {
    clearResult();
    var banner = BANNERS[data.status] || BANNERS.error;
    var bannerText = banner[1];
    if (data.status === 'step_failed') {
      bannerText = '证明无效 —— 第 ' + data.failedStep + ' 步检验失败，当时有效约束摘要附后';
    }
    resultEl.appendChild(el('div', 'banner banner-' + banner[0], bannerText));

    if (data.status === 'invalid_input') {
      renderErrors(data.errors || []);
      return;
    }
    if (data.stats) {
      resultEl.appendChild(el('p', 'stats',
        '初始约束 ' + data.stats.cnfClauses + ' 条 · 证明步骤 ' + data.stats.steps + ' 步'));
    }
    if (data.steps && data.steps.length) {
      renderSteps(data.steps);
    }
    if (data.summary) {
      renderSummary(data.summary, data.status === 'step_failed' ? '失败时刻的有效约束摘要' : '终态有效约束摘要');
    }
  }

  function renderErrors(errors) {
    var box = el('div', 'panel errors');
    box.appendChild(el('h2', null, '合并定位的输入问题（共 ' + errors.length + ' 处）'));
    var table = el('table', 'err-table');
    var head = el('tr', null);
    ['来源', '行号', '类别', '说明'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    errors.forEach(function (e) {
      var tr = el('tr', null);
      tr.appendChild(el('td', null, e.source === 'cnf' ? 'CNF 约束' : 'DRAT 记录'));
      tr.appendChild(el('td', 'num', '第 ' + e.line + ' 行'));
      tr.appendChild(el('td', 'mono', e.kind));
      tr.appendChild(el('td', null, e.message));
      table.appendChild(tr);
    });
    box.appendChild(table);
    resultEl.appendChild(box);
  }

  function renderSteps(steps) {
    var box = el('div', 'panel');
    box.appendChild(el('h2', null, '逐步复核记录（共 ' + steps.length + ' 步' +
      (steps.length > STEP_BATCH ? '，分批渲染以保持页面可操作' : '') + '）'));
    var list = el('div', 'steps');
    var moreBtn = el('button', 'ghost');
    var shown = 0;

    function renderBatch() {
      var end = Math.min(shown + STEP_BATCH, steps.length);
      for (var i = shown; i < end; i++) list.appendChild(stepNode(steps[i]));
      shown = end;
      if (shown < steps.length) {
        moreBtn.textContent = '渲染更多（剩余 ' + (steps.length - shown) + ' 步）';
        moreBtn.hidden = false;
      } else {
        moreBtn.hidden = true;
      }
    }

    moreBtn.addEventListener('click', renderBatch);
    box.appendChild(list);
    box.appendChild(moreBtn);
    resultEl.appendChild(box);
    renderBatch();
  }

  function stepNode(step) {
    var node = el('details', 'step ' + (step.ok ? 'step-ok' : 'step-fail'));
    if (!step.ok) node.open = true;
    var head = el('summary', null);
    var mark = step.ok ? '✓' : '✗';
    var label;
    if (step.type === 'delete') {
      label = '#' + step.index + ' 删除 ' + fmtClause(step.clause) + ' —— 规则 DELETE，移除子句 c' + step.deletedId;
    } else if (step.ok) {
      label = '#' + step.index + ' 新增 ' + fmtClause(step.clause) + ' —— 规则 ' + step.rule + '，编号 c' + step.id;
    } else {
      label = '#' + step.index + ' 新增 ' + fmtClause(step.clause) + ' —— RUP / RAT 均未通过';
    }
    head.textContent = mark + ' ' + label;
    node.appendChild(head);

    var body = el('div', 'step-body');
    body.appendChild(el('p', 'mono dim', '对应 DRAT 记录第 ' + step.line + ' 行'));
    if (step.type === 'delete') {
      body.appendChild(el('p', null, '子句 c' + step.deletedId + ' ' + fmtClause(step.clause) +
        ' 已自活动集移除，立即影响后续推导依据，且不得再被引用。'));
    } else {
      if (step.rup) body.appendChild(rupNode('RUP 单位传播', step.rup));
      if (step.rat) body.appendChild(ratNode(step.rat));
      if (!step.ok && step.reason) body.appendChild(el('p', 'fail-reason', step.reason));
    }
    node.appendChild(body);
    return node;
  }

  function rupNode(title, rup) {
    var box = el('div', 'check');
    box.appendChild(el('h3', null, title + '：' + (rup.ok ? '导出冲突 ✓' : '未导出冲突 ✗')));
    var text = '假设 ' + (rup.assumptions.length ? rup.assumptions.map(fmtLit).join('，') : '（空子句，无假设）');
    text += '；冲突子句编号链：' + fmtChain(rup.chain, rup.conflict);
    box.appendChild(el('p', 'mono', text));
    return box;
  }

  function ratNode(rat) {
    var box = el('div', 'check');
    box.appendChild(el('h3', null, 'RAT 检验（指定枢轴 ' + fmtLit(rat.pivot) + '）：' + (rat.ok ? '成立 ✓' : '不成立 ✗')));
    if (rat.vacuous) {
      box.appendChild(el('p', null, '当前活动集中无含反向文字 ' + fmtLit(-rat.pivot) + ' 的子句 —— 空悬（vacuous）成立。'));
      return box;
    }
    box.appendChild(el('p', null, '全部反向文字子句的核对结果（共 ' + rat.checks.length + ' 条）：'));
    var ul = el('ul', 'rat-list');
    rat.checks.forEach(function (chk) {
      var line = '对 c' + chk.clauseId + '：归结式 ' + fmtClause(chk.resolvent) + ' —— ';
      if (chk.tautological) {
        line += '重言式，平凡成立 ✓';
      } else {
        line += (chk.ok ? 'RUP ✓（' : 'RUP ✗（') + fmtChain(chk.rup.chain, chk.rup.conflict) + '）';
      }
      ul.appendChild(el('li', 'mono', line));
    });
    box.appendChild(ul);
    return box;
  }

  function renderSummary(summary, title) {
    var box = el('div', 'panel');
    box.appendChild(el('h2', null, title));
    box.appendChild(el('p', 'stats',
      '变量数 ' + summary.vars + ' · 活动子句 ' + summary.activeCount + ' 条 · 已删除 ' + summary.deletedCount + ' 条'));
    var list = el('div', 'chips');
    var cap = Math.min(summary.active.length, ACTIVE_CAP);
    for (var i = 0; i < cap; i++) {
      list.appendChild(el('span', 'chip mono', 'c' + summary.active[i].id + ' ' + fmtClause(summary.active[i].lits)));
    }
    if (summary.active.length > cap) {
      list.appendChild(el('span', 'chip dim', '… 其余 ' + (summary.active.length - cap) + ' 条从略'));
    }
    box.appendChild(list);
    resultEl.appendChild(box);
  }

  function renderFatal(msg) {
    clearResult();
    resultEl.appendChild(el('div', 'banner banner-bad', msg));
  }

  /* ---------- 工具 ---------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function fmtLit(l) {
    return l < 0 ? '¬' + (-l) : String(l);
  }

  function fmtClause(lits) {
    if (!lits || lits.length === 0) return '⊥（空子句）';
    return '[ ' + lits.map(fmtLit).join(' ') + ' ]';
  }

  function fmtChain(chain, conflict) {
    var parts = chain.slice(0, CHAIN_CAP).map(function (e) {
      return 'c' + e.clauseId + ' ⊢ ' + fmtLit(e.forced);
    });
    if (chain.length > CHAIN_CAP) parts.push('…（链过长，其余 ' + (chain.length - CHAIN_CAP) + ' 环从略）');
    if (conflict != null) parts.push('c' + conflict + ' ⊢ ⊥');
    return parts.length ? parts.join(' → ') : '（无传播）';
  }

  restoreDraft();
})();
