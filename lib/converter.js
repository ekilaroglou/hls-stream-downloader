/**
 * MPEG-TS -> MP4 conversion on background threads (see convert-worker.js), so
 * downloading and converting happen at the same time. Returns a function for
 * StreamDownload's `convert` option: (track, bytes, reset) -> Promise of
 * [{ initSegment, data }]. The bytes are handed over to the worker (not copied).
 */
export function workerConverter(url = new URL('./convert-worker.js', import.meta.url)) {
  const workers = new Map(); // track ('main' | 'audio') -> { worker, waiting }
  let nextId = 1;

  function workerFor(track) {
    if (!workers.has(track)) {
      const worker = new Worker(url);
      const waiting = new Map();
      worker.onmessage = ({ data }) => {
        const call = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.error) call?.reject(new Error(`Converting the video failed: ${data.error}`));
        else call?.resolve(data.outputs);
      };
      worker.onerror = (e) => {
        e.preventDefault();
        const error = new Error(`Converting the video failed: ${e.message || 'background thread error'}`);
        waiting.forEach((call) => call.reject(error));
        waiting.clear();
      };
      workers.set(track, { worker, waiting });
    }
    return workers.get(track);
  }

  const convert = (track, bytes, reset) =>
    new Promise((resolve, reject) => {
      const { worker, waiting } = workerFor(track);
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      // Hand the whole buffer over; copy first if the bytes are part of a larger one.
      const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
      worker.postMessage({ id, data, reset }, [data.buffer]);
    });
  convert.close = () => {
    workers.forEach(({ worker }) => worker.terminate());
    workers.clear();
  };
  return convert;
}
