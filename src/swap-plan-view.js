import { pauseWindow } from './swap-plan.js';

export function swatch(palette, index) {
  const item = document.createElement('span');
  item.className = 'slice-swatch';
  item.style.setProperty('--swatch', palette[index]);
  item.textContent = 'Color ' + (index + 1);
  item.title = palette[index];
  return item;
}
export function showPlan(planPanel, {palette, bottom}, plan) {
  const element = (tag, text) => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  planPanel.hidden = false;
  planPanel.append(element('h3', 'Toolhead swap plan'));
  if (!plan) {
    planPanel.append(element('p', 'No fixed filament-to-head mapping fits this limit. Some colors overlap at different heights.'));
    return;
  }
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  for (const title of ['Head', 'Load first', 'Also uses']) header.append(element('th', title));
  const body = table.createTBody();
  plan.heads.forEach(([first, ...later], index) => {
    const row = body.insertRow();
    row.insertCell().textContent = String(index + 1);
    row.insertCell().append(swatch(palette,first));
    const cell = row.insertCell();
    if (!later.length) cell.textContent = '—';
    later.forEach(color => cell.append(swatch(palette,color)));
  });
  planPanel.append(table);
  if (!plan.pauses.length) {
    planPanel.append(element('p', 'No swaps needed.'));
    return;
  }
  planPanel.append(element('h4', 'Pause windows · mm above model base'));
  const list = document.createElement('ol');
  const more = element('button', 'Show more pauses');
  more.type = 'button';
  let shown = 0;
  function nextPage() {
    const end = Math.min(plan.pauses.length, shown + 25);
    for (; shown < end; shown++) {
      const {lo, hi, swaps} = plan.pauses[shown];
      const range = pauseWindow({lo, hi}, bottom);
      const entry = document.createElement('li');
      entry.append(element('strong', range));
      for (const {head,from,to} of swaps) {
        const line = document.createElement('div');
        line.append('Head ' + (head+1) + ' · ', swatch(palette,from), ' → ', swatch(palette,to));
        entry.append(line);
      }
      list.append(entry);
    }
    more.hidden = shown >= plan.pauses.length;
  }
  nextPage();
  more.onclick = nextPage;
  planPanel.append(list, more, element('p', 'In Orca Preview, confirm a layer break after the outgoing color finishes and before the incoming color starts. Check supports and the final print orientation.'));
}
