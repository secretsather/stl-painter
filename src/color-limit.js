
export function setupColorLimit(model) {
  const control = document.getElementById('color-limit');
  const report = document.getElementById('color-limit-report');
  const summary = document.getElementById('color-limit-summary');
  const colors = document.getElementById('color-limit-colors');
  const preference = localStorage.getItem('horizontalColorLimit') ?? '4';
  for (let n = 1; n <= 16; n++) control.add(new Option(String(n), String(n)));
  control.value = preference;
  if (!control.value) control.value = '4';

  let worker, sentSurface, active, pending;
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
    worker = sentSurface = active = pending = null;
  }
  function sendNext() {
    if (active || !pending) return;
    active = pending;
    pending = null;
    const { surface, limit } = active;
    const paint = active.snapshot ?? active.paint.slice();
    const heights = surface !== sentSurface ? surface.heightRanges() : null;
    sentSurface = surface;
    worker.postMessage(
      { paint, limit, heights, masks: active.masks },
      heights ? [paint.buffer, heights.buffer] : [paint.buffer]
    );
  }
  function showResult(request, conflict) {
    if (conflict) {
      const z = Number((conflict.z - request.bottom).toFixed(2));
      show(
        `${conflict.count} colors at Z ≈ ${z} mm (limit ${request.limit}).`,
        `${conflict.count} used / ${request.limit} allowed`,
        true
      );
      request.palette.forEach((hex, i) => {
        if (!(conflict.mask & (1 << i))) return;
        const item = document.createElement('span');
        item.style.setProperty('--swatch', hex);
        item.textContent = 'Color ' + (i + 1);
        item.title = hex;
        colors.append(item);
      });
    } else show('Within the selected color limit.');
  }
  function receive({ data: conflict }) {
    const { paint, paintRevision, key, surface } = active;
    surface.sliceCheck = { paint, paintRevision, key, conflict };
    if (!pending) showResult(active, conflict);
    active = null;
    sendNext();
  }
  function refresh() {
    const limit = Number(control.value);
    report.hidden = !limit;
    const { paint, palette, surface, bottom, masks, paintRevision } = model();
    if (!limit || palette.length <= limit) {
      stop();
      show(limit ? 'Within the selected color limit.' : '');
      return;
    }
    const key = [limit, ...masks].join(',');
    const request = { key, limit, surface, bottom, masks, paint, palette, paintRevision };
    const previous = surface.sliceCheck;
    if (!active && previous?.paint === paint && previous.paintRevision === paintRevision && previous.key === key) {
      showResult(request, previous.conflict);
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
    pending = request;
    show('Checking slice colors…', 'checking…');
    sendNext();
  }
  control.onchange = () => {
    localStorage.setItem('horizontalColorLimit', control.value);
    refresh();
  };
  refresh.beforeStroke = () => {
    // A brush writes directly into committed paint until mouse-up.
    if (pending && !pending.snapshot) pending.snapshot = pending.paint.slice();
  };
  return refresh;
}
