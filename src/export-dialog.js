import { filamentMasks, physicalSlots } from './mixes.js';
import { showPlan } from './swap-plan-view.js';

export function chooseExport(project, surface, bottom, paintRevision) {
  const el = id => document.getElementById(id);
  const dialog = el('export-dialog'), limit = el('export-heads'), confirm = el('confirm-export');
  const panel = el('export-plan'), status = el('export-status');
  const full = dialog.querySelector('[value="full"]'), limited = dialog.querySelector('[value="heads"]');
  const palette = physicalSlots(project).map(slot => project.palette[slot]);
  const masks = filamentMasks(project);
  if (!limit.options.length) {
    for (let n = 1; n <= 16; n++) limit.add(new Option(String(n), String(n)));
  }
  limit.value = String(Number(el('color-limit').value) || 4);
  full.checked = true;
  dialog.returnValue = '';
  let worker, plan;
  const cache = new Map();
  function refresh() {
    worker?.terminate();
    worker = null;
    plan = null;
    panel.replaceChildren();
    panel.hidden = status.hidden = true;
    confirm.disabled = limited.checked;
    if (!limited.checked) return;
    const count = Number(limit.value);
    function display(result) {
      cache.set(count, result);
      const {conflict} = result;
      plan = result.plan;
      if (conflict) {
        status.textContent = conflict.count + ' filaments overlap at about ' +
          Number((conflict.z-bottom).toFixed(2)) + ' mm. Increase the head count or choose Full color.';
        status.hidden = false;
      } else {
        status.hidden = true;
        showPlan(panel, {palette, bottom}, plan);
      }
      confirm.disabled = !plan;
    }
    const saved = surface.sliceCheck;
    if (cache.has(count)) return display(cache.get(count));
    if (saved?.paint === project.paint && saved.paintRevision === paintRevision &&
        saved.key === [count, ...masks].join(',')) return display(saved.result);
    status.textContent = 'Checking painted height ranges…';
    status.hidden = false;
    const job = worker = new Worker('./color-check-worker.js');
    job.onmessage = ({data}) => { if (job === worker) display(data); };
    job.onerror = () => {
      if (job === worker) status.textContent = 'Could not calculate the swap plan. Reopen Export to retry.';
    };
    const heights = palette.length > count ? surface.heightRanges() : null;
    job.postMessage({heights, paint:project.paint, limit:count, masks}, heights ? [heights.buffer] : []);
  }
  dialog.onchange = event => {
    if (event.target === limit) limited.checked = true;
    refresh();
  };
  refresh();
  dialog.showModal();
  return new Promise(resolve => {
    function finish(choice) {
      worker?.terminate();
      dialog.oncancel = dialog.onsubmit = dialog.onchange = el('cancel-export').onclick = null;
      dialog.close();
      resolve(choice);
    }
    dialog.oncancel = event => {
      event.preventDefault();
      finish(null);
    };
    el('cancel-export').onclick = () => finish(null);
    dialog.onsubmit = event => {
      event.preventDefault();
      if (!confirm.disabled) finish(limited.checked ? {plan, bottom, palette} : {});
    };
  });
}
