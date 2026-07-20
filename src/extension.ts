import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DataStore } from './dataStore';
import { GoPackageTreeProvider } from './treeProvider';
import { log, logError } from './log';
import { ViewElement } from './types';

let dataStore: DataStore;
let treeProvider: GoPackageTreeProvider;

export async function activate(context: vscode.ExtensionContext) {
  log('activate() called');
  dataStore = new DataStore();
  treeProvider = new GoPackageTreeProvider(dataStore);

  vscode.window.registerTreeDataProvider('goPackageView', treeProvider);

  // ── Open file on click ──────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('goPackageView.openFile', async (filePath?: string) => {
      if (!filePath) return;
      log('openFile:', filePath);
      const uri = vscode.Uri.file(path.resolve(filePath));
      const doc = await vscode.workspace.openTextDocument(uri);
      vscode.window.showTextDocument(doc);
    }),
  );

  // ── Refresh tree ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('goPackageView.refresh', async () => {
      await loadAndRefresh();
    }),
  );

  // ── Copy import path ────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('goPackageView.copyImportPath', async (node?: ViewElement) => {
      if (!node || !node.importPath) return;
      await vscode.env.clipboard.writeText(node.importPath);
      vscode.window.showInformationMessage('Copied: ' + node.importPath);
    }),
  );

  // ── Open terminal in package directory ──────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('goPackageView.openInTerminal', async (node?: ViewElement) => {
      if (!node || node.kind !== 'package') return;
      const info = dataStore.getPackageInfo(node.importPath);
      if (info?.Dir) {
        const terminal = vscode.window.createTerminal({ cwd: info.Dir, name: node.label });
        terminal.show();
      }
    }),
  );

  // ── Reveal file in OS file manager ──────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('goPackageView.revealFileInOS', async (node?: ViewElement) => {
      if (!node || node.kind !== 'file' || !node.filePath) return;
      const uri = vscode.Uri.file(path.resolve(node.filePath));
      vscode.commands.executeCommand('revealFileInOS', uri);
    }),
  );

  // ── New file in package ─────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('goPackageView.newFile', async (node?: ViewElement) => {
      if (!node || node.kind !== 'package') return;
      const info = dataStore.getPackageInfo(node.importPath);
      if (!info?.Dir) {
        vscode.window.showErrorMessage('Cannot determine package directory');
        return;
      }
      const fileName = await vscode.window.showInputBox({
        prompt: 'Enter file name (e.g. handler.go)',
        placeHolder: 'handler.go',
        validateInput: (v: string | undefined) => {
          if (!v) return 'Required';
          if (!v.endsWith('.go')) return 'Must end with .go';
          return null;
        },
      });
      if (!fileName) return;
      const filePath = path.join(info.Dir, fileName);
      if (fs.existsSync(filePath)) {
        vscode.window.showErrorMessage('File already exists: ' + fileName);
        return;
      }
      const pkgName = path.basename(info.Dir);
      fs.writeFileSync(filePath, 'package ' + pkgName + '\n\n');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      vscode.window.showTextDocument(doc);
      loadAndRefresh();
    }),
  );

  // ── New subdirectory (sub-package) ──────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('goPackageView.newSubdirectory', async (node?: ViewElement) => {
      if (!node || node.kind !== 'package') return;
      const info = dataStore.getPackageInfo(node.importPath);
      if (!info?.Dir) {
        vscode.window.showErrorMessage('Cannot determine package directory');
        return;
      }
      const dirName = await vscode.window.showInputBox({
        prompt: 'Enter subdirectory name (e.g. models)',
        placeHolder: 'models',
        validateInput: (v: string | undefined) => {
          if (!v) return 'Required';
          if (!/^[a-z][a-z0-9_]*$/.test(v)) return 'Invalid Go package name';
          return null;
        },
      });
      if (!dirName) return;
      const dirPath = path.join(info.Dir, dirName);
      if (fs.existsSync(dirPath)) {
        vscode.window.showErrorMessage('Directory already exists');
        return;
      }
      fs.mkdirSync(dirPath, { recursive: true });
      const initFile = path.join(dirPath, dirName + '.go');
      fs.writeFileSync(initFile, 'package ' + dirName + '\n\n');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(initFile));
      vscode.window.showTextDocument(doc);
      loadAndRefresh();
    }),
  );

  // ── Delete folder ───────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('goPackageView.deleteFolder', async (node?: ViewElement) => {
      if (!node || node.kind !== 'package') return;
      const info = dataStore.getPackageInfo(node.importPath);
      if (!info?.Dir) {
        vscode.window.showErrorMessage('Cannot determine package directory');
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        'Delete ' + info.Dir + ' and all its contents?',
        { modal: true },
        'Delete',
      );
      if (answer !== 'Delete') return;
      fs.rmSync(info.Dir, { recursive: true, force: true });
      loadAndRefresh();
    }),
  );

  // ── Auto-refresh on file changes ────────────────────
  const watcher = vscode.workspace.createFileSystemWatcher('**/{go.mod,go.sum,*.go}');
  watcher.onDidChange(debounce(() => {
    if (vscode.workspace.getConfiguration('goPackageView').get('autoRefresh', true)) {
      loadAndRefresh();
    }
  }, 300));
  watcher.onDidCreate(debounce(() => {
    if (vscode.workspace.getConfiguration('goPackageView').get('autoRefresh', true)) {
      loadAndRefresh();
    }
  }, 300));
  context.subscriptions.push(watcher);

  // ── Initial load ────────────────────────────────────
  await loadAndRefresh();
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

async function loadAndRefresh() {
  log('loadAndRefresh()');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) {
    log('No workspace folder open');
    vscode.window.showInformationMessage('Go Package View: No workspace folder open');
    return;
  }
  log('workspaceRoot:', workspaceRoot);
  const ok = await dataStore.refresh(workspaceRoot);
  log('refresh result:', ok, 'error:', dataStore.error);
  treeProvider.refresh();
  if (!ok && dataStore.error) {
    logError('Failed:', dataStore.error);
    vscode.window.showWarningMessage('Go Package View: ' + dataStore.error);
  }
}

export function deactivate() {
  // Nothing special to clean up
}
