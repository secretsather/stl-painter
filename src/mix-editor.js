import { filamentGroups, mixHex, physicalSlots, recipeLabel, validRecipe } from './mixes.js';

const pairRatios = [[50, 50], [33, 67], [67, 33]];
const trioRatios = [[33, 33, 34], [33, 34, 33], [34, 33, 33]];
const recipeKey = parts => parts.map(({slot, percent}) => `${slot}=${percent}`).sort().join(',');

const MAX_SUGGESTIONS = 90;

function suggestedRecipes(physical, current) {
  const groups = [...filamentGroups(physical)];
  const makeRecipe = (slots, weights) => slots.map((slot, i) => ({slot, percent: weights[i]}));
  if (groups.length * 3 <= MAX_SUGGESTIONS) {
    return groups.flatMap(slots => (slots.length === 2 ? pairRatios : trioRatios)
      .map(weights => makeRecipe(slots, weights)));
  }

  // Sample across the entire palette before computing print colors or creating buttons.
  // Give pairs and trios equal space, cycling through all three presets in each set.
  const recipes = [];
  const budget = MAX_SUGGESTIONS / 2;
  for (const ratios of [pairRatios, trioRatios]) {
    const size = ratios[0].length;
    const choices = groups.filter(slots => slots.length === size);
    const sampled = Array.from({length: budget}, (_, i) =>
      makeRecipe(choices[Math.floor(i * choices.length / budget)], ratios[i % 3]));
    if (current?.length === size && !sampled.some(parts => recipeKey(parts) === recipeKey(current))) {
      sampled[sampled.length - 1] = current;
    }
    recipes.push(...sampled);
  }
  return recipes;
}

export function chooseMix(project, slot, accept) {
  const $ = id => document.getElementById(id);
  const dialog = $('mix-editor'), count = $('mix-count'), rows = $('mix-parts');
  const physical = physicalSlots(project);
  const initial = project.mixes?.[slot];
  const occupied = new Set();
  project.palette.forEach((hex, i) => {
    if (i === slot) return;
    occupied.add(hex);
    if (project.mixes?.[i]) occupied.add(mixHex(project.palette, project.mixes[i]));
  });
  const suggestions = new Map();
  let highlighted;
  count.options[1].disabled = physical.length < 3;
  count.value = String(initial?.length ?? 2);
  $('mix-title').textContent = initial ? 'Edit mixed color' : 'Add mixed color';
  $('confirm-mix').textContent = initial ? 'Save mix' : 'Add mix';
  let parts;
  function update() {
    parts = [...rows.children].map(row => ({
      slot: Number(row.querySelector('select').value),
      percent: row.querySelector('input').valueAsNumber,
    }));
    const valid = validRecipe(parts, physical);
    const hex = valid ? mixHex(project.palette, parts) : '';
    const duplicate = occupied.has(hex);
    highlighted?.setAttribute('aria-pressed', 'false');
    highlighted = valid ? suggestions.get(recipeKey(parts)) : undefined;
    highlighted?.setAttribute('aria-pressed', 'true');
    $('mix-error').textContent = duplicate ? 'This color already exists.' :
      valid ? '' : 'Choose distinct filaments with whole percentages totaling 100%.';
    $('mix-preview').firstElementChild.style.setProperty('--swatch', hex || 'transparent');
    $('mix-preview').lastElementChild.textContent = hex ? 'Estimated print color ' + hex : '';
    $('confirm-mix').disabled = !valid || duplicate;
    for (const select of rows.querySelectorAll('select')) {
      for (const option of select.options)
        option.disabled = option.value !== select.value && parts.some(part => part.slot === Number(option.value));
    }
  }
  function showSuggestions() {
    const list = $('mix-suggestions');
    const swatches = document.createDocumentFragment();
    for (const recipe of suggestedRecipes(physical, initial)) {
      const hex = mixHex(project.palette, recipe);
      const button = document.createElement('button');
      button.type = 'button';
      button.style.setProperty('--swatch', hex);
      button.disabled = occupied.has(hex);
      button.title = recipeLabel(recipe, physical) + ' · ' + hex + (button.disabled ? ' (already in palette)' : '');
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', 'false');
      button.onclick = () => {
        count.value = String(recipe.length);
        build(recipe);
      };
      suggestions.set(recipeKey(recipe), button);
      swatches.append(button);
    }
    const total = suggestions.size;
    list.style.setProperty('--columns', Math.min(total, Math.max(10, Math.ceil(Math.sqrt(total * 3)))));
    list.replaceChildren(swatches);
  }
  function build(previous) {
    const n = Number(count.value);
    const slots = [...new Set([...(previous ?? []).map(p => p.slot), ...physical])];
    rows.replaceChildren();
    for (let i = 0; i < n; i++) {
      const row = document.createElement('div');
      row.className = 'mix-part';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Filament ' + (i + 1));
      physical.forEach((id, j) => select.add(new Option(`Color ${j + 1} · ${project.palette[id]}`, id)));
      select.value = slots[i];
      select.onchange = update;
      const share = document.createElement('input');
      share.type = 'number';
      share.min = 33;
      share.max = n === 2 ? 67 : 34;
      share.step = 1;
      share.required = true;
      share.value = previous?.length === n ? previous[i].percent : n === 2 ? 50 : i === 0 ? 34 : 33;
      share.setAttribute('aria-label', 'Filament ' + (i + 1) + ' percentage');
      share.oninput = () => {
        if (share.validity.valid) {
          const inputs = [...rows.querySelectorAll('input')];
          if (n === 2) inputs[1 - i].value = 100 - share.valueAsNumber;
          else {
            let extra = share.valueAsNumber === 34 ? i :
              inputs.findIndex((el, j) => j !== i && el.valueAsNumber === 34);
            if (extra < 0) extra = (i + 1) % 3;
            inputs.forEach((el, j) => { el.value = j === extra ? 34 : 33; });
          }
        }
        update();
      };
      row.append(select, share, '%');
      rows.append(row);
    }
    update();
  }
  showSuggestions();
  build(initial);
  count.onchange = () => build(parts);
  dialog.returnValue = '';
  dialog.onclose = () => {
    if (dialog.returnValue === 'confirm' && !$('confirm-mix').disabled) accept(parts);
  };
  dialog.showModal();
}
