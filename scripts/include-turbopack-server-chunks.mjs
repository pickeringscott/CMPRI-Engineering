import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const serverRoot = path.join(projectRoot, '.next', 'server');
const chunksRoot = path.join(serverRoot, 'chunks');
const appRoot = path.join(serverRoot, 'app');
const chunkReference = /R\.c\(["']server\/chunks\/([^"']+)["']\)/g;
const entries = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(filePath);
    } else if (entry.isFile() && /(?:page|route)\.js$/.test(entry.name)) {
      entries.push(filePath);
    }
  }
}

async function collectChunks(sourcePath) {
  const pending = [sourcePath];
  const chunks = new Set();

  while (pending.length) {
    const current = pending.pop();
    const source = await readFile(current, 'utf8');

    for (const match of source.matchAll(chunkReference)) {
      const relativeChunk = match[1].replaceAll('/', path.sep);
      const chunkPath = path.resolve(chunksRoot, relativeChunk);
      const relativeToChunks = path.relative(chunksRoot, chunkPath);

      if (relativeToChunks.startsWith('..') || path.isAbsolute(relativeToChunks)) {
        throw new Error(`Turbopack chunk escapes the server chunks directory: ${match[1]}`);
      }
      if (chunks.has(chunkPath)) continue;

      await readFile(chunkPath);
      chunks.add(chunkPath);
      pending.push(chunkPath);
    }
  }

  return chunks;
}

if (!(await readdir(appRoot)).length) {
  throw new Error(`Next.js server app output is missing: ${appRoot}`);
}

await walk(appRoot);

let tracedEntries = 0;
let addedChunks = 0;

for (const entryPath of entries) {
  const tracePath = `${entryPath}.nft.json`;
  let trace;

  try {
    trace = JSON.parse(await readFile(tracePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    trace = { version: 1, files: [] };
  }

  const files = new Set(trace.files);
  const chunks = await collectChunks(entryPath);

  for (const chunkPath of chunks) {
    const relativePath = path.relative(path.dirname(entryPath), chunkPath).split(path.sep).join('/');
    if (!files.has(relativePath)) {
      files.add(relativePath);
      addedChunks++;
    }
  }

  trace.files = [...files].sort();
  await writeFile(tracePath, `${JSON.stringify(trace)}\n`);
  if (chunks.size) tracedEntries++;
}

console.log(`Added ${addedChunks} Turbopack server chunk trace entries across ${tracedEntries} routes.`);
