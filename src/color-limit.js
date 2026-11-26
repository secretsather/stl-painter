import { cellHeights } from './color-at-height.js';

export function setupColorLimit(model) {
  const control = document.getElementById('color-limit');
  const report = document.getElementById('color-limit-report');
  const summary = document.getElementById('color-limit-summary');
  const colors = document.getElementById('color-limit-colors');
  const preference = localStorage.getItem('horizontalColorLimit') ?? '4';
  for (let n = 1; n <= 16; n++) control.add(new Option(String(n), String(n)));
  control.value = preference;
  if (!control.value) control.value = '4';

  let worker, sentPositions, active, pending;
  function show(
    message,
    badge = control.value === '0' ? 'off' : 'limit ' + control.value,
    warning = false
  ) {
    document.getElementById('slice-status').classList.toggle('warning', warning);
    document.getElementById('slice-status-label').textContent = 'Slice colors · ' + badge;
    report.classList.toggle('warning', warning);
    summary.textContent = message;
    colors.replaceChildren();
  }
  function stop() {
    if (worker) {
      worker.onmessage = worker.onerror = null;
      worker.terminate();
    }
    worker = sentPositions = active = pending = null;
  }
  function sendNext() {
    if (active || !pending) return;
    active = pending;
    pending = null;
    const { positions, paint, limit } = active;
    const heights = positions !== sentPositions ? cellHeights(positions) : null;
    sentPositions = positions;
    worker.postMessage(
      { paint, limit, heights, masks: active.masks },
      heights ? [paint.buffer, heights.buffer] : [paint.buffer]
    );
  }
  function receive({ data: conflict }) {
    if (!pending) {
      if (conflict) {
        const z = Number((conflict.z - active.bottom).toFixed(2));
        show(
          `${conflict.count} colors at Z ≈ ${z} mm (limit ${active.limit}).`,
          `${conflict.count} used / ${active.limit} allowed`,
          true
        );
        active.palette.forEach((hex, i) => {
          if (!(conflict.mask & (1 << i))) return;
          const item = document.createElement('span');
          item.style.setProperty('--swatch', hex);
          item.textContent = 'Color ' + (i + 1);
          item.title = hex;
          colors.append(item);
        });
      } else show('Within the selected color limit.');
    }
    active = null;
    sendNext();
  }
  function refresh() {
    const limit = Number(control.value);
    report.hidden = !limit;
    const { paint, palette, positions, bottom, masks } = model();
    if (!limit || palette.length <= limit) {
      stop();
      show(limit ? 'Within the selected color limit.' : '');
      return;
    }
    if (!worker) {
      worker = new Worker('./color-check-worker.js');
      worker.onmessage = receive;
      worker.onerror = () => {
        stop();
        show('Color check unavailable.', 'unavailable', true);
      };
    }
    // Snapshot committed paint. If more edits arrive during a check, run
    // only the newest one next and discard the superseded result.
    pending = { limit, positions, bottom, masks, paint: paint.slice(), palette: palette.slice() };
    show('Checking slice colors…', 'checking…');
    sendNext();
  }
  control.onchange = () => {
    localStorage.setItem('horizontalColorLimit', control.value);
    refresh();
  };
  return refresh;
}
