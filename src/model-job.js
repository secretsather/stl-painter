function workerJob(worker, message, transfer, timeout) {
  let timer;
  return new Promise((resolve, reject) => {
    if (timeout) timer = setTimeout(() => reject(Error('The repair time limit was reached.')), timeout);
    worker.onmessage = ({ data }) => data.error ? reject(Error(data.error)) : resolve(data.value);
    worker.onerror = event => reject(Error(event.message || 'Model processing failed.'));
    worker.postMessage(message, transfer);
  }).finally(() => { clearTimeout(timer); worker.terminate(); });
}

export function modelJob(message, transfer = []) {
  return workerJob(new Worker('./model-worker.js'), message, transfer);
}

export async function repairJob(mesh) {
  try {
    const worker = new Worker('./repair-worker.js', { type: 'module' });
    return await workerJob(worker, mesh, [], 60_000);
  } catch (err) {
    return { warning: 'The geometry check could not finish. ' + err.message };
  }
}

export class FillJobs {
  constructor() {
    this.worker = new Worker('./fill-worker.js');
    this.pending = new Map();
    this.sequence = 0;
    this.worker.onmessage = ({ data }) => {
      const job = this.pending.get(data.id);
      if (!job) return;
      if (data.progress !== undefined) {
        job.onProgress?.(data.progress);
        return;
      }
      this.pending.delete(data.id);
      if (data.error) job.reject(Error(data.error));
      else job.resolve(data.value);
    };
    this.worker.onerror = e => this.close(e.message);
  }
  request(message, transfers = [], onProgress) {
    if (this.closed) return Promise.reject(Error(this.closed));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, ...message }, transfers);
    });
  }
  prepare(project, view) {
    const mesh = this.versions ? undefined : { faces: project.faces, depth: project.depth,
      vertices: { length: project.vertices.length } };
    const changes = [];
    const versions = view.chunks.map((chunk, index) => {
      if (this.versions?.[index] !== chunk.version) {
        const { node, endNode } = chunk.range;
        changes.push({ index, splits: project.splits?.slice(node, endNode) });
      }
      return chunk.version;
    });
    this.versions = versions;
    return this.request({ mesh, ranges: view.ranges, changes, seams: project.seams, owners: view.surface.owners,
      normals: mesh && view.surface.normals }, changes.flatMap(c => c.splits ? [c.splits.buffer] : []));
  }
  region(paint, revision, seed, angle, protect, lockedSlots, stopAtSeams) {
    const changed = this.paint !== paint || this.revision !== revision;
    this.paint = paint;
    this.revision = revision;
    return this.request({ seed, angle, protect, lockedSlots, stopAtSeams, paint: changed ? paint : undefined });
  }
  gaps(view, project, threshold, includeSeams, onProgress) {
    let positions;
    if (this.gapVersion !== view.chunkVersion) {
      positions = new Float32Array(project.paint.length * 9);
      for (const { range, data } of view.chunks) positions.set(data.positions, range.cell * 9);
      this.gapVersion = view.chunkVersion;
    }
    return this.request({ threshold, includeSeams, positions, gapPaint: project.paint, lockedSlots: project.lockedSlots },
      positions ? [positions.buffer] : [], onProgress);
  }
  close(reason = 'Project changed.') {
    this.closed = reason;
    this.worker.terminate();
    for (const job of this.pending.values()) job.reject(Error(reason));
    this.pending.clear();
  }
}
