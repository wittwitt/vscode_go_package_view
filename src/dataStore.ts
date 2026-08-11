import { GoPackageInfo, ParsedData, SearchableGoFile, TreeMode } from './types';
import * as path from 'path';
import {
  runGoList,
  findGoModDir,
  categorizeImports,
  buildRevDeps,
  findLibraryRoots,
  isModuleInternal,
} from './goListRunner';
import { log, logError } from './log';

export class DataStore {
  private _parsed: ParsedData | null = null;
  private _error: string | null = null;
  private _revDeps: Map<string, string[]> | null = null;
  private _libraryRoots: string[] | null = null;
  private _mode: TreeMode = 'normal';
  private _goModDir: string | null = null;
  private _abortController: AbortController | null = null;

  get parsed(): ParsedData | null { return this._parsed; }
  get error(): string | null { return this._error; }
  get mode(): TreeMode { return this._mode; }
  get goModDir(): string | null { return this._goModDir; }
  get revDeps(): Map<string, string[]> | null { return this._revDeps; }
  get libraryRoots(): string[] | null { return this._libraryRoots; }

  get hasData(): boolean {
    return this._parsed !== null && this._parsed.packages.size > 0;
  }

  async refresh(workspaceRoot: string): Promise<boolean> {
    log('DataStore.refresh() workspaceRoot:', workspaceRoot);

    if (this._abortController) {
      log('DataStore.refresh: aborting previous go list');
      this._abortController.abort();
    }

    this._error = null;

    const goModDir = findGoModDir(workspaceRoot);
    if (!goModDir) {
      log('DataStore.refresh: no go.mod found');
      this._error = 'No go.mod found in workspace, workspace/src, or parent directories';
      this._parsed = null;
      this._goModDir = null;
      return false;
    }
    log('DataStore.refresh: goModDir =', goModDir);

    this._goModDir = goModDir;

    try {
      this._abortController = new AbortController();
      const parsed = await runGoList(goModDir, this._abortController.signal);
      this._parsed = parsed;

      if (parsed.mainPkgs.length > 0) {
        this._mode = 'normal';
        this._revDeps = null;
        this._libraryRoots = null;
        log('DataStore.refresh: mode=normal, main packages:', parsed.mainPkgs.map(p => p.ImportPath));
      } else {
        this._mode = 'library';
        log('DataStore.refresh: mode=library, building reverse deps');
        this._revDeps = buildRevDeps(parsed);
        this._libraryRoots = findLibraryRoots(parsed, this._revDeps);
        log('DataStore.refresh: library roots:', this._libraryRoots);
      }

      this._abortController = null;
      log('DataStore.refresh: completed successfully');
      return true;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        log('DataStore.refresh: aborted');
        return false;
      }
      logError('DataStore.refresh: error -', err.message || String(err));
      this._error = err.message || String(err);
      this._parsed = null;
      this._abortController = null;
      return false;
    }
  }

  getRoots(): { label: string; importPath: string }[] {
    if (!this._parsed) {
      log('DataStore.getRoots: no parsed data, returning empty');
      return [];
    }

    let roots: { label: string; importPath: string }[];
    if (this._mode === 'normal') {
      roots = this._parsed.mainPkgs.map(p => ({
        label: this._shorten(p.ImportPath),
        importPath: p.ImportPath,
      }));
    } else {
      roots = (this._libraryRoots || []).map(p => ({
        label: p,
        importPath: p,
      }));
    }
    log('DataStore.getRoots: returning', roots.length, 'roots:', roots.map(r => r.label));
    return roots;
  }

 getChildrenOfPackage(importPath: string): {
   files: { name: string; dir: string }[];
   packageChildren: string[];
 } | null {
    if (!this._parsed) {
      log('DataStore.getChildrenOfPackage(' + importPath + '): no parsed data');
      return null;
    }
    const info = this._parsed.packages.get(importPath);
    if (!info) {
      log('DataStore.getChildrenOfPackage(' + importPath + '): package not found in cache');
      return null;
    }
    log('DataStore.getChildrenOfPackage(' + importPath + '): Name=' + info.Name + ', GoFiles=' + JSON.stringify(info.GoFiles) + ', Imports=' + JSON.stringify(info.Imports));

    const cats = categorizeImports(info, this._parsed.packages, this._parsed.modulePath);
    const files = (info.GoFiles || []).sort().map(f => ({
      name: f,
      dir: info.Dir || '',
    }));

    let packageChildren: string[];
    if (this._mode === 'normal') {
      packageChildren = [...cats.internal, ...cats.external];
    } else {
      packageChildren = this._revDeps?.get(importPath) || [];
    }

    log('DataStore.getChildrenOfPackage(' + importPath + '): files=' + files.length + ' subPackages=' + packageChildren.length);
    return { files, packageChildren };
  }

  getPackageInfo(importPath: string): GoPackageInfo | undefined {
    return this._parsed?.packages.get(importPath);
  }

  /** Return every Go source file known to `go list`, including dependencies. */
  getSearchableFiles(): SearchableGoFile[] {
    if (!this._parsed) return [];

    const files: SearchableGoFile[] = [];
    const seen = new Set<string>();
    for (const [importPath, info] of this._parsed.packages) {
      if (!info.Dir) continue;
      const names = [
        ...(info.GoFiles || []),
        ...(info.CgoFiles || []),
        ...(info.TestGoFiles || []),
        ...(info.XTestGoFiles || []),
      ];
      for (const fileName of names) {
        const filePath = path.join(info.Dir, fileName);
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        files.push({ filePath, fileName, importPath });
      }
    }
    return files.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  isInternal(importPath: string): boolean {
    if (!this._parsed) return false;
    return isModuleInternal(importPath, this._parsed.modulePath);
  }

  /**
   * Get a short display label for a module-internal import path.
   */
  shorten(importPath: string): string {
    return this._shorten(importPath);
  }

  private _shorten(importPath: string): string {
    if (this._parsed && importPath.startsWith(this._parsed.modulePath + '/')) {
      return importPath.slice(this._parsed.modulePath.length + 1);
    }
    return importPath;
  }
}
