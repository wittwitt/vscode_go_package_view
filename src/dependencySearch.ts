import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { DataStore } from './dataStore';
import { SearchableGoFile } from './types';
import { log } from './log';

const MAX_RESULTS = 500;
const READ_CONCURRENCY = 16;

interface DependencySearchResult extends vscode.QuickPickItem {
  filePath: string;
  line: number;
  startCharacter: number;
  matchLength: number;
}

export async function searchDependencies(store: DataStore): Promise<void> {
  if (!store.hasData) {
    vscode.window.showInformationMessage('Go Package View: No dependency data loaded');
    return;
  }

  const query = await vscode.window.showInputBox({
    title: 'Search Go Dependencies',
    prompt: 'Search text in all Go source files returned by go list -deps',
    placeHolder: 'Text to search for',
    ignoreFocusOut: true,
    validateInput: value => value.length === 0 ? 'Enter search text' : null,
  });
  if (!query) return;

  const files = store.getSearchableFiles();
  const results = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Searching ${files.length} dependency files for “${query}”`,
      cancellable: true,
    },
    async (progress, token) => searchFiles(files, query, progress, token),
  );

  if (!results) return;
  if (results.length === 0) {
    vscode.window.showInformationMessage(`Go Package View: No results for “${query}”`);
    return;
  }

  const picked = await vscode.window.showQuickPick(results, {
    title: `Dependency Search: “${query}” (${results.length}${results.length === MAX_RESULTS ? '+' : ''} results)`,
    placeHolder: 'Select a result to open it',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.filePath));
  const editor = await vscode.window.showTextDocument(document);
  const start = new vscode.Position(picked.line, picked.startCharacter);
  const end = new vscode.Position(picked.line, picked.startCharacter + picked.matchLength);
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function searchFiles(
  files: SearchableGoFile[],
  query: string,
  progress: vscode.Progress<{ increment?: number; message?: string }>,
  token: vscode.CancellationToken,
): Promise<DependencySearchResult[] | undefined> {
  const results: DependencySearchResult[] = [];
  const needle = query.toLocaleLowerCase();
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (!token.isCancellationRequested && results.length < MAX_RESULTS) {
      const index = nextIndex++;
      if (index >= files.length) return;
      const file = files[index];
      try {
        const content = await fs.readFile(file.filePath, 'utf8');
        appendMatches(results, file, content, needle, query.length);
      } catch (error) {
        log('dependency search: skipped', file.filePath, String(error));
      }
      completed++;
      progress.report({
        increment: files.length > 0 ? 100 / files.length : 100,
        message: `${completed}/${files.length} files`,
      });
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(READ_CONCURRENCY, files.length) },
    () => worker(),
  ));
  if (token.isCancellationRequested) return undefined;
  return results.slice(0, MAX_RESULTS);
}

function appendMatches(
  results: DependencySearchResult[],
  file: SearchableGoFile,
  content: string,
  needle: string,
  matchLength: number,
): void {
  const lines = content.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length && results.length < MAX_RESULTS; lineIndex++) {
    const line = lines[lineIndex];
    const lowerLine = line.toLocaleLowerCase();
    let from = 0;
    while (from <= lowerLine.length && results.length < MAX_RESULTS) {
      const character = lowerLine.indexOf(needle, from);
      if (character < 0) break;
      results.push({
        label: `$(file-code) ${file.fileName}:${lineIndex + 1}`,
        description: file.importPath,
        detail: line.trim() || '(empty line)',
        filePath: file.filePath,
        line: lineIndex,
        startCharacter: character,
        matchLength,
      });
      from = character + Math.max(matchLength, 1);
    }
  }
}
