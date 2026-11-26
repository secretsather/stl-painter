import { parentPort } from 'node:worker_threads';
import { openSync, writeSync, closeSync } from 'node:fs';
import { stream3MF, writeProject } from '../src/files.js';

parentPort.on('message', ({ temporary, project, exporting }) => {
  try {
    const fd = openSync(temporary, 'wx');
    function append(chunk) {
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
    }
    try {
      if (exporting) stream3MF(project, append);
      else append(writeProject(project));
    } finally {
      closeSync(fd);
    }
    parentPort.postMessage({});
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
