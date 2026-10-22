import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';

export function createExclusiveArchiveSink(archivePath) {
  const stream = createWriteStream(archivePath, { flags: 'wx' });
  let ownsFile = false;
  stream.once('open', () => { ownsFile = true; });
  return { stream, ownsFile: () => ownsFile };
}

export async function removePartialArchive(archivePath, ownsFile) {
  if (ownsFile === true) await rm(archivePath, { force: true });
}
