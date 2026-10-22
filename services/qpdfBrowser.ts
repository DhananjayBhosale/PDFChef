import { createQpdfRunner } from 'qpdf-run';
import qpdfWorkerUrl from 'qpdf-run/worker?url';
import qpdfJsUrl from 'qpdf-run/qpdf.js?url';
import qpdfWasmUrl from 'qpdf-run/qpdf.wasm?url';

const runQpdf = async (input: Uint8Array, args: string[]) => {
  const runner = await createQpdfRunner({
    workerUrl: qpdfWorkerUrl,
    qpdfJsUrl,
    wasmUrl: qpdfWasmUrl,
    timeoutMs: 120_000,
  });
  try {
    return await runner.runOne({
      input,
      inputName: 'input.pdf',
      outputName: 'output.pdf',
      args,
    });
  } finally {
    await runner.destroy();
  }
};

export const encryptPdfWithAes128 = (input: Uint8Array, password: string) => runQpdf(input, [
  '--encrypt', password, password, '128',
  '--use-aes=y',
  '--print=full',
  '--modify=none',
  '--extract=n',
  '--',
  'input.pdf',
  'output.pdf',
]);

// With no password, qpdf opens the file with the empty one, which is how an owner-only file opens.
export const decryptPdf = (input: Uint8Array, password: string) => runQpdf(input, [
  ...(password ? [`--password=${password}`] : []),
  '--decrypt',
  '--',
  'input.pdf',
  'output.pdf',
]);
