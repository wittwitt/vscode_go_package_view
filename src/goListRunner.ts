import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GoPackageInfo, ParsedData } from './types';
import { log, logError } from './log';

export function findGoModDir(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    log('findGoModDir: checking', dir);
    if (fs.existsSync(path.join(dir, 'go.mod'))) {
      log('findGoModDir: found at', dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  log('findGoModDir: not found starting from', startDir);
  return null;
}

export function extractModulePath(goModDir: string): string {
  const filePath = path.join(goModDir, 'go.mod');
  log('extractModulePath: reading', filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^module\s+(\S+)/m);
  if (!match) {
    logError('extractModulePath: no module directive in', filePath);
    throw new Error('Could not parse module path from go.mod');
  }
  log('extractModulePath:', match[1]);
  return match[1];
}

export async function runGoList(
  goModDir: string,
  signal?: AbortSignal,
): Promise<ParsedData> {
  log('runGoList: starting go list -json -deps ./... in', goModDir);
  const modulePath = extractModulePath(goModDir);
  log('runGoList: modulePath =', modulePath);

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'go',
      ['list', '-json', '-deps', './...'],
        { cwd: goModDir, maxBuffer: 100 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        if (err) {
          if (stdout && stdout.length > 0) {
            log('runGoList: go list exited with error but has partial stdout');
            resolve(stdout);
          } else {
            logError('runGoList: go list failed, stderr:', stderr);
            reject(new Error(stderr || err.message));
          }
        } else {
          resolve(stdout);
        }
      },
    );
  });

  log('runGoList: got', (stdout.length / 1024 / 1024).toFixed(1), 'MB of output');

  const packages = new Map<string, GoPackageInfo>();
  const mainPkgs: GoPackageInfo[] = [];

  // Parse streaming JSON objects by tracking { } depth.
  // go list -json output can be multi-line per package.
  let buf = '';
  let depth = 0;
  let objCount = 0;
  for (const ch of stdout) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    buf += ch;
    if (depth === 0 && buf.trim().length > 0) {
      objCount++;
      try {
        const info = JSON.parse(buf.trim()) as GoPackageInfo;
        if (!info || !info.ImportPath) {
          log('runGoList: skipping entry with no ImportPath');
          buf = '';
          continue;
        }
       packages.set(info.ImportPath, info);
       if (
         info.Name === 'main' &&
         info.ImportPath.startsWith(modulePath)
       ) {
         log('runGoList: found main package:', info.ImportPath);
         mainPkgs.push(info);
       }
      } catch (parseErr) {
        log('runGoList: failed to parse object:', String(parseErr).slice(0, 120));
      }
      buf = '';
    }
  }

  if (buf.trim().length > 0) {
    log('runGoList: trailing unparsed data, length=' + buf.length);
  }

  log('runGoList: parsed', objCount, 'objects ->', packages.size, 'packages,', mainPkgs.length, 'main packages');
  return { modulePath, packages, mainPkgs };
}

export function isModuleInternal(importPath: string, modulePath: string): boolean {
  if (!importPath || !modulePath) return false;
  return (
    importPath === modulePath ||
    importPath.startsWith(modulePath + '/')
  );
}

export function categorizeImports(
  info: GoPackageInfo,
  allPkgs: Map<string, GoPackageInfo>,
  modulePath: string,
): { stdlib: string[]; internal: string[]; external: string[] } {
  const stdlib: string[] = [];
  const internal: string[] = [];
  const external: string[] = [];
  for (const imp of (info.Imports || [])) {
    if (!imp) continue;
    const pkg = allPkgs.get(imp);
    if (pkg?.Standard) {
      stdlib.push(imp);
    } else if (isModuleInternal(imp, modulePath)) {
      internal.push(imp);
    } else {
      external.push(imp);
    }
  }
  stdlib.sort();
  internal.sort();
  external.sort();
  return { stdlib, internal, external };
}

export function buildRevDeps(parsed: ParsedData): Map<string, string[]> {
  log('buildRevDeps: scanning', parsed.packages.size, 'packages');
  const rev = new Map<string, string[]>();
  for (const [importPath, info] of parsed.packages) {
    if (!importPath) continue;
    if (!isModuleInternal(importPath, parsed.modulePath)) continue;
    for (const imp of (info.Imports || [])) {
      if (!imp) continue;
      if (!isModuleInternal(imp, parsed.modulePath)) continue;
      const list = rev.get(imp);
      if (list) { list.push(importPath); }
      else { rev.set(imp, [importPath]); }
    }
  }
  for (const [, v] of rev) { v.sort(); }
  log('buildRevDeps: found', rev.size, 'reverse dep entries');
  return rev;
}

export function findLibraryRoots(parsed: ParsedData, revDeps: Map<string, string[]>): string[] {
  log('findLibraryRoots: scanning for root packages (no internal deps)');
  const roots: string[] = [];
  for (const [importPath, info] of parsed.packages) {
    if (!importPath) continue;
    if (!isModuleInternal(importPath, parsed.modulePath)) continue;
    const cats = categorizeImports(info, parsed.packages, parsed.modulePath);
    if (cats.internal.length === 0) {
      log('findLibraryRoots: root candidate:', importPath);
      roots.push(importPath);
    }
  }
  roots.sort();
  log('findLibraryRoots: found', roots.length, 'roots:', roots);
  return roots;
}
