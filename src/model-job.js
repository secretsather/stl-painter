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
      this.pending.delete(data.id);
      if (data.error) job.reject(Error(data.error));
      else job.resolve(data.graph);
    };
    this.worker.onerror = e => this.close(e.message);
  }
  get(project, view) {
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
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, mesh, ranges: view.ranges, changes },
        changes.flatMap(c => c.splits ? [c.splits.buffer] : []));
      this.versions = versions;
    });
  }
  close(reason = 'Project changed.') {
    this.worker.terminate();
    for (const job of this.pending.values()) job.reject(Error(reason));
    this.pending.clear();
  }
}
