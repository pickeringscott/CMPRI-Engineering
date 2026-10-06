import { cp, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function includeRoomOperationsLinuxImages({ projectRoot, functionsRoot, manifestPath, filePathMap, listFiles }) {
  const relativeManifest = path.relative(functionsRoot, manifestPath).split(path.sep).join('/');
  if (!/^api\/room-operations\/extract(?:\.rsc)?\.func\/\.vc-config\.json$/.test(relativeManifest)
    || !Object.keys(filePathMap).some(filePath => filePath.startsWith('node_modules/sharp/'))) {
    return;
  }

  const sharpRoot = path.join(projectRoot, 'node_modules', 'sharp');
  const sharpPackage = JSON.parse(await readFile(path.join(sharpRoot, 'package.json'), 'utf8'));
  for (const name of ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']) {
    const packageRoot = path.join(projectRoot, 'node_modules', ...name.split('/'));
    let imagePackage;
    try {
      imagePackage = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`Room Operations extraction requires ${name} for Vercel's Linux x64 runtime. Install Sharp's matching Linux optional dependencies before packaging.`);
    }
    if (imagePackage.version !== sharpPackage.optionalDependencies[name]
      || !imagePackage.os?.includes('linux') || !imagePackage.cpu?.includes('x64')) {
      throw new Error(`Incompatible Room Operations extraction dependency: ${name}. Use the version declared by Sharp for Linux x64.`);
    }
    for (const filePath of await listFiles(packageRoot)) {
      const relativePath = path.relative(projectRoot, filePath).split(path.sep).join('/');
      filePathMap[relativePath] = relativePath;
    }
  }

  const sharpLinks = Object.keys(filePathMap).filter(filePath => /^\.next\/node_modules\/sharp-[^/]+$/.test(filePath));
  for (const link of sharpLinks) {
    const portableRoot = path.join(projectRoot, ...link.split('/'));
    let existing;
    try {
      existing = await lstat(portableRoot);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing?.isSymbolicLink()) await unlink(portableRoot);
    else if (existing && !existing.isDirectory()) throw new Error(`Invalid Sharp runtime directory: ${link}`);
    await mkdir(portableRoot, { recursive: true });
    await cp(sharpRoot, portableRoot, { recursive: true, dereference: true });
    delete filePathMap[link];
    for (const filePath of await listFiles(portableRoot)) {
      const relativePath = path.relative(projectRoot, filePath).split(path.sep).join('/');
      filePathMap[relativePath] = relativePath;
    }
  }
}
