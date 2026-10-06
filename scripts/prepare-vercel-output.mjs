import { cp, lstat, readFile, readdir, readlink, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { includeRoomOperationsLinuxImages } from './room-operations-image-runtime.mjs';

const projectRoot = process.cwd();
const outputRoot = path.join(projectRoot, '.vercel', 'output');
const functionsRoot = path.join(outputRoot, 'functions');
const chunksRoot = path.join(projectRoot, '.next', 'server', 'chunks');
const chunkReference = /R\.c\(["']server\/chunks\/([^"']+)["']\)/g;

async function listFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        files.push(filePath);
      } else if (entry.isDirectory()) {
        await walk(filePath);
      } else {
        files.push(filePath);
      }
    }
  }
  await walk(directory);
  return files;
}

async function materializeFunctionLinks() {
  const entries = await listFiles(functionsRoot);
  const links = [];
  for (const filePath of entries) {
    if ((await lstat(filePath)).isSymbolicLink()) links.push(filePath);
  }
  const resolvedLinks = [];

  for (const link of links) {
    const target = path.resolve(path.dirname(link), await readlink(link));
    const relative = path.relative(functionsRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !(await lstat(target)).isDirectory()) {
      throw new Error(`Unsafe or missing Vercel function link target: ${link}`);
    }
    resolvedLinks.push({ link, target });
  }

  for (const { link, target } of resolvedLinks) {
    await unlink(link);
    await cp(target, link, { recursive: true, dereference: true, preserveTimestamps: true });
  }

  return resolvedLinks.length;
}

async function collectChunkClosure(entryFiles) {
  const pending = [...entryFiles];
  const chunks = new Set();

  while (pending.length) {
    const entry = pending.pop();
    const source = await readFile(entry, 'utf8');

    for (const match of source.matchAll(chunkReference)) {
      const chunkPath = path.resolve(chunksRoot, match[1].replaceAll('/', path.sep));
      const relative = path.relative(chunksRoot, chunkPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Chunk reference escapes the chunks directory: ${match[1]}`);
      }
      if (chunks.has(chunkPath)) continue;
      await readFile(chunkPath);
      chunks.add(chunkPath);
      pending.push(chunkPath);
    }
  }

  return chunks;
}

const functionLinks = await materializeFunctionLinks();
const functionFiles = await listFiles(functionsRoot);
const manifests = functionFiles.filter(filePath => path.basename(filePath) === '.vc-config.json');
let manifestChunkRefs = 0;
let unresolvedReferences = [];

for (const manifestPath of manifests) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const filePathMap = manifest.filePathMap ?? {};
  for (const [logicalPath, sourcePath] of Object.entries(filePathMap)) {
    if (/^\.env(?:\.|$)/i.test(logicalPath) || /^\.env(?:\.|$)/i.test(sourcePath)) {
      delete filePathMap[logicalPath];
    }
  }
  const entries = Object.entries(filePathMap)
    .filter(([key]) => /\.next\/server\/app\/.+\/(?:page|route)\.js$/.test(key))
    .map(([, value]) => path.resolve(projectRoot, value));

  for (const entry of entries) {
    const tracePath = `${entry}.nft.json`;
    const trace = JSON.parse(await readFile(tracePath, 'utf8'));
    for (const tracedFile of trace.files) {
      const sourcePath = path.resolve(path.dirname(tracePath), tracedFile);
      const relativePath = path.relative(projectRoot, sourcePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`Traced function file escapes the project directory: ${tracedFile}`);
      }
      const relativeManifestPath = relativePath.split(path.sep).join('/');
      if (/^\.env(?:\.|$)/i.test(relativeManifestPath)) continue;
      filePathMap[relativeManifestPath] = relativeManifestPath;
    }
  }

  const chunks = await collectChunkClosure(entries);

  for (const chunkPath of chunks) {
    const relativeChunk = path.relative(projectRoot, chunkPath).split(path.sep).join('/');
    filePathMap[relativeChunk] = relativeChunk;
    manifestChunkRefs++;
  }

  await includeRoomOperationsLinuxImages({ projectRoot, functionsRoot, manifestPath, filePathMap, listFiles });

  manifest.filePathMap = filePathMap;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  for (const [logicalPath, sourcePath] of Object.entries(filePathMap)) {
    if (/^\.env(?:\.|$)/i.test(logicalPath) || /^\.env(?:\.|$)/i.test(sourcePath)) {
      unresolvedReferences.push(`Environment file referenced by ${manifestPath}: ${logicalPath}`);
    }
    try {
      await stat(path.resolve(projectRoot, sourcePath));
    } catch {
      unresolvedReferences.push(`Missing function file in ${manifestPath}: ${sourcePath}`);
    }
  }
}

if (unresolvedReferences.length) {
  throw new Error(unresolvedReferences.slice(0, 20).join('\n'));
}

console.log(JSON.stringify({
  materializedFunctionLinks: functionLinks,
  functionManifests: manifests.length,
  includedRuntimeChunks: manifestChunkRefs,
  unresolvedReferences: unresolvedReferences.length,
}));
