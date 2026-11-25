export function setupSidebar(divider) {
  const main = divider.parentElement;
  const minimum = 240;
  let preferred = Number(localStorage.getItem('paintingSidebarWidth')) || null;
  let width, maximum, drag;

  function layout() {
    maximum = Math.max(minimum, Math.min(520, Math.floor(main.clientWidth * 0.48)));
    const fallback = parseInt(getComputedStyle(main).getPropertyValue('--default-sidebar-width'), 10);
    width = Math.max(minimum, Math.min(maximum, preferred ?? fallback));
    main.style.setProperty('--sidebar-width', width + 'px');
    divider.setAttribute('aria-valuemin', minimum);
    divider.setAttribute('aria-valuemax', maximum);
    divider.setAttribute('aria-valuenow', width);
    divider.setAttribute('aria-valuetext', width + ' pixels');
  }
  function setWidth(next) {
    preferred = Math.max(minimum, Math.min(maximum, Math.round(next)));
    layout();
  }
  function reset() {
    preferred = null;
    localStorage.removeItem('paintingSidebarWidth');
    layout();
  }
  divider.addEventListener('pointerdown', (e) => {
    if (drag || e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, width };
    divider.setPointerCapture(e.pointerId);
  });
  divider.addEventListener('pointermove', (e) => {
    if (drag?.id === e.pointerId) setWidth(drag.width + drag.x - e.clientX);
  });
  divider.addEventListener('lostpointercapture', (e) => {
    if (drag?.id !== e.pointerId) return;
    if (preferred !== null) localStorage.setItem('paintingSidebarWidth', preferred);
    drag = null;
  });
  divider.addEventListener('dblclick', reset);
  divider.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') reset();
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      setWidth(width + (e.key === 'ArrowLeft' ? 16 : -16));
      localStorage.setItem('paintingSidebarWidth', preferred);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  layout();
  new ResizeObserver(layout).observe(main);
}
