export function modelJob(message, transfer = []) {
  const worker = new Worker('./model-worker.js');
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => data.error ? reject(Error(data.error)) : resolve(data.value);
    worker.onerror = event => reject(Error(event.message || 'Model processing failed.'));
    worker.postMessage(message, transfer);
  }).finally(() => worker.terminate());
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
    return this.request({ mesh, ranges: view.ranges, changes, owners: view.surface.owners,
      normals: mesh && view.surface.normals }, changes.flatMap(c => c.splits ? [c.splits.buffer] : []));
  }
  region(paint, revision, seed, angle, protect, lockedSlots) {
    const changed = this.paint !== paint || this.revision !== revision;
    this.paint = paint;
    this.revision = revision;
    return this.request({ seed, angle, protect, lockedSlots, paint: changed ? paint : undefined });
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
