export function setupImportPreview(view, fitButton) {
  let zoom = 1, centerX = 0.5, centerY = 0.5, drag = null;

  function scale() {
    const canvas = view.firstElementChild;
    return zoom * Math.min(view.clientWidth / canvas.width, view.clientHeight / canvas.height);
  }

  function draw() {
    const canvas = view.firstElementChild;
    if (!canvas || !view.clientWidth) return;
    centerX = Math.max(0, Math.min(1, centerX));
    centerY = Math.max(0, Math.min(1, centerY));
    const s = scale();
    const left = view.clientWidth / 2 - centerX * canvas.width * s;
    const top = view.clientHeight / 2 - centerY * canvas.height * s;
    canvas.style.transform = `translate(${left}px, ${top}px) scale(${s})`;
  }

  function fit() {
    zoom = 1;
    centerX = centerY = 0.5;
    draw();
  }

  function pan(dx, dy) {
    const canvas = view.firstElementChild;
    const s = scale();
    centerX -= dx / (canvas.width * s);
    centerY -= dy / (canvas.height * s);
    draw();
  }

  // Offsets are measured from the viewport center in screen pixels.
  function zoomAt(factor, dx, dy) {
    const before = zoom;
    zoom = Math.max(1, Math.min(16, before * factor));
    if (zoom === 1) return fit();
    pan(dx * (1 - zoom / before), dy * (1 - zoom / before));
  }

  view.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = view.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1;
    zoomAt(Math.exp(-event.deltaY * unit * 0.002),
      event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
  }, { passive: false });
  view.onpointerdown = (event) => {
    if (event.button !== 0 || drag) return;
    view.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  view.onpointermove = (event) => {
    if (drag?.id !== event.pointerId) return;
    pan(event.clientX - drag.x, event.clientY - drag.y);
    drag.x = event.clientX;
    drag.y = event.clientY;
  };
  view.onlostpointercapture = () => { drag = null; };
  view.onkeydown = (event) => {
    switch (event.key) {
      case '+': case '=': zoomAt(1.25, 0, 0); break;
      case '-': zoomAt(0.8, 0, 0); break;
      case 'ArrowLeft': pan(32, 0); break;
      case 'ArrowRight': pan(-32, 0); break;
      case 'ArrowUp': pan(0, 32); break;
      case 'ArrowDown': pan(0, -32); break;
      default: return;
    }
    event.preventDefault();
  };
  new ResizeObserver(draw).observe(view);
  fitButton.onclick = fit;
  return {
    fit,
    show(canvas) {
      view.replaceChildren(canvas);
      draw();
    },
  };
}
