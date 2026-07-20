import * as vscode from 'vscode';
import * as path from 'path';
import { DataStore } from './dataStore';
import { ViewElement } from './types';
import { log } from './log';

/** Colored icon file paths, relative to dist/extension.js */
const ICONS_DIR = vscode.Uri.file(path.join(__dirname, '..', 'icons'));

function pkgEl(importPath: string, label: string, libraryMode?: boolean): ViewElement {
  return { kind: 'package', importPath, label, libraryMode };
}

function fileEl(importPath: string, fileName: string, filePath: string): ViewElement {
  return { kind: 'file', importPath, label: fileName, fileName, filePath };
}

export class GoPackageTreeProvider implements vscode.TreeDataProvider<ViewElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ViewElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: DataStore) {
    log('GoPackageTreeProvider: constructed');
  }

  refresh(): void {
    log('GoPackageTreeProvider.refresh()');
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ViewElement): vscode.TreeItem {
    log('getTreeItem:', element.kind, element.label);
    switch (element.kind) {
     case 'package': {
        const isExternal = !this.store.isInternal(element.importPath);
        const iconName = isExternal ? 'go-package-external.svg' : 'go-package.svg';
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = {
          light: vscode.Uri.joinPath(ICONS_DIR, iconName),
          dark: vscode.Uri.joinPath(ICONS_DIR, iconName),
        };
        item.contextValue = 'goPackage';
        item.tooltip = element.importPath;
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = {
          light: vscode.Uri.joinPath(ICONS_DIR, 'go-file.svg'),
          dark: vscode.Uri.joinPath(ICONS_DIR, 'go-file.svg'),
        };
        item.command = {
          command: 'goPackageView.openFile',
          title: 'Open File',
          arguments: [element.filePath],
        };
        item.contextValue = 'goFile';
        return item;
      }
    }
  }

  getChildren(element?: ViewElement): vscode.ProviderResult<ViewElement[]> {
    const src = element ? element.label : '(root)';
    log('getChildren:', src);

    if (!this.store.hasData) {
      log('getChildren: no data in store');
      return [];
    }

    if (!element) {
      const roots = this.store.getRoots();
      log('getChildren: returning', roots.length, 'root elements');
      return roots.map(r => pkgEl(r.importPath, r.label, this.store.mode === 'library'));
    }

    if (element.kind === 'package') {
      const result = this.getPackageChildren(element.importPath, element.libraryMode);
      log('getChildren: package', element.label, '->', result.length, 'children');
      return result;
    }

    return [];
  }

  private getPackageChildren(importPath: string, libraryMode?: boolean): ViewElement[] {
    const children = this.store.getChildrenOfPackage(importPath);
    if (!children) return [];
    const result: ViewElement[] = [];
    for (const f of children.files) {
      const filePath = f.dir ? f.dir + '/' + f.name : f.name;
      result.push(fileEl(importPath, f.name, filePath));
    }
    for (const subPkg of children.packageChildren) {
      result.push(pkgEl(subPkg, this.store.shorten(subPkg), libraryMode || this.store.mode === 'library'));
    }
    return result;
  }
}
