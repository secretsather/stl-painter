import { initMeshRepair } from 'meshrepair';
import wasmBinary from 'meshrepair/meshrepair.wasm';
import { checkMesh } from './repair.js';

self.onmessage = async ({ data }) => {
  try {
    const engine = await initMeshRepair({ wasmBinary });
    const value = checkMesh(engine, data);
    const arrays = Object.values(value.mesh ?? {}).filter(ArrayBuffer.isView);
    self.postMessage({ value }, arrays.map(a => a.buffer));
  } catch (error) {
    self.postMessage({ error: error.message || 'The mesh check failed.' });
  }
};
