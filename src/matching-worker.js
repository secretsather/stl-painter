import { mapImage } from './stamps.js';
import { mixCandidates } from './mixes.js';

let image, project, candidates;
const session = {};
self.onmessage = ({ data }) => {
  if (data.image) {
    image = data.image;
    project = data.project;
    return;
  }
  try {
    const { mode, limit, cutoff, capacity } = data;
    const result = mapImage(image, project.palette, limit, cutoff, {
      capacity, mixes: project.mixes, session,
      candidates: mode === 'mix' ? (candidates ??= mixCandidates(project)) : undefined,
    });
    self.postMessage({ result }, [result.pixels.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
